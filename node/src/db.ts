/**
 * Saves alerts, API calls and de-duplication state, so they survive restarts and redeploys.
 * The tables and the JSON inside them are the same as the Python app's, so either version
 * can read what the other wrote.
 *
 * DATABASE_URL picks where:
 *   sqlite:///data/triage.db         a local file (relative paths are under the repository root)
 *   postgresql://user:pass@host/db   Postgres, e.g. Render or Neon (needed on Render: its disk is
 *                                    wiped on every deploy)
 *   (empty)                          nothing is saved; everything lives in memory only
 */

import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import pg from "pg";
import type { DedupEntry } from "./dedup.js";
import { ApiCallSchema, Investigation, type ApiCall } from "./models.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS investigations (
     id TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     data TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS api_calls (
     id {autoid},
     app TEXT NOT NULL,
     method TEXT NOT NULL,
     path TEXT NOT NULL,
     status INTEGER NOT NULL,
     duration_ms DOUBLE PRECISION NOT NULL,
     time TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS dedup (
     fingerprint TEXT PRIMARY KEY,
     investigation_id TEXT NOT NULL,
     first_seen DOUBLE PRECISION NOT NULL,
     count INTEGER NOT NULL)`,
];

type Row = Record<string, any>;

/** The few SQL operations we need, on SQLite or Postgres, with "?" placeholders. */
interface Driver {
  run(sql: string, params?: unknown[]): Promise<void>;
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  /** Several statements in one transaction. */
  transaction(statements: [string, unknown[]][]): Promise<void>;
  close(): Promise<void>;
}

class SqliteDriver implements Driver {
  private readonly db: BetterSqlite3.Database;
  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new BetterSqlite3(file);
  }
  async run(sql: string, params: unknown[] = []) {
    this.db.prepare(sql).run(...params);
  }
  async all(sql: string, params: unknown[] = []) {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  async transaction(statements: [string, unknown[]][]) {
    this.db.transaction(() => {
      for (const [sql, params] of statements) this.db.prepare(sql).run(...params);
    })();
  }
  async close() {
    this.db.close();
  }
}

class PostgresDriver implements Driver {
  private readonly pool: pg.Pool;
  constructor(url: string) {
    // A pool reconnects by itself, so a dropped connection never breaks the app for good.
    this.pool = new pg.Pool({ connectionString: url, max: 3 });
  }
  private static sql(statement: string): string {
    let n = 0;
    return statement.replace(/\?/g, () => `$${++n}`);
  }
  async run(sql: string, params: unknown[] = []) {
    await this.pool.query(PostgresDriver.sql(sql), params);
  }
  async all(sql: string, params: unknown[] = []) {
    return (await this.pool.query(PostgresDriver.sql(sql), params)).rows;
  }
  async transaction(statements: [string, unknown[]][]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [sql, params] of statements) await client.query(PostgresDriver.sql(sql), params);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}

export class Database {
  private constructor(
    private readonly driver: Driver,
    readonly isPostgres: boolean,
  ) {}

  static async open(url: string, projectRoot: string): Promise<Database> {
    let db: Database;
    if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
      db = new Database(new PostgresDriver(url), true);
    } else if (url.startsWith("sqlite:///")) {
      const file = url.slice("sqlite:///".length);
      db = new Database(new SqliteDriver(path.isAbsolute(file) ? file : path.join(projectRoot, file)), false);
    } else {
      throw new Error(`DATABASE_URL must start with sqlite:/// or postgresql://, got ${JSON.stringify(url)}`);
    }
    const autoid = db.isPostgres ? "BIGSERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
    for (const statement of SCHEMA) await db.driver.run(statement.replace("{autoid}", autoid));
    return db;
  }

  close(): Promise<void> {
    return this.driver.close();
  }

  /** Raw access, for tests. */
  run(sql: string, params: unknown[] = []): Promise<void> {
    return this.driver.run(sql, params);
  }

  // ------------------------------------------------------------------ investigations

  async saveInvestigation(inv: Investigation): Promise<void> {
    await this.driver.run(
      "INSERT INTO investigations (id, created_at, data) VALUES (?, ?, ?) " +
        "ON CONFLICT (id) DO UPDATE SET data = excluded.data",
      [inv.id, inv.created_at.toISOString(), JSON.stringify(inv)],
    );
  }

  async deleteInvestigation(id: string): Promise<void> {
    await this.driver.run("DELETE FROM investigations WHERE id = ?", [id]);
  }

  /** The newest `limit` investigations, oldest first (the store's insertion order). */
  async loadInvestigations(limit: number): Promise<Investigation[]> {
    const rows = await this.driver.all("SELECT data FROM investigations ORDER BY created_at DESC LIMIT ?", [limit]);
    return rows.reverse().map((r) => Investigation.fromJSON(r.data));
  }

  // ------------------------------------------------------------------ API calls

  async addCalls(calls: ApiCall[], keep: number): Promise<void> {
    if (!calls.length) return;
    const insert = "INSERT INTO api_calls (app, method, path, status, duration_ms, time) VALUES (?, ?, ?, ?, ?, ?)";
    await this.driver.transaction([
      ...calls.map((c): [string, unknown[]] => [insert, [c.app, c.method, c.path, c.status, c.duration_ms, c.time.toISOString()]]),
      // Keep only the newest `keep` calls, like the in-memory store.
      ["DELETE FROM api_calls WHERE id <= (SELECT id FROM api_calls ORDER BY id DESC LIMIT 1 OFFSET ?)", [keep]],
    ]);
  }

  async loadCalls(limit: number): Promise<ApiCall[]> {
    const rows = await this.driver.all(
      "SELECT app, method, path, status, duration_ms, time FROM api_calls ORDER BY id DESC LIMIT ?",
      [limit],
    );
    return rows.reverse().map((r) => ApiCallSchema.parse({ ...r, status: Number(r.status), duration_ms: Number(r.duration_ms) }));
  }

  // ------------------------------------------------------------------ de-duplication

  async saveDedup(fp: string, entry: DedupEntry): Promise<void> {
    await this.driver.run(
      "INSERT INTO dedup (fingerprint, investigation_id, first_seen, count) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (fingerprint) DO UPDATE SET investigation_id = excluded.investigation_id, " +
        "first_seen = excluded.first_seen, count = excluded.count",
      [fp, entry.investigation_id, entry.first_seen, entry.count],
    );
  }

  async loadDedup(newerThan: number): Promise<Map<string, DedupEntry>> {
    await this.driver.run("DELETE FROM dedup WHERE first_seen < ?", [newerThan]);
    const rows = await this.driver.all("SELECT fingerprint, investigation_id, first_seen, count FROM dedup");
    return new Map(
      rows.map((r) => [r.fingerprint, { investigation_id: r.investigation_id, first_seen: Number(r.first_seen), count: Number(r.count) }]),
    );
  }
}

export async function openDatabase(url: string, projectRoot: string): Promise<Database | null> {
  return url ? Database.open(url, projectRoot) : null;
}
