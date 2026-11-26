/**
 * De-duplication: a repeat of an alert is merged into the first one (its count goes up)
 * while that first one is still open (queued / running), or within DEDUP_TTL_MIN minutes.
 * Once it is closed, or no longer kept, a repeat starts a new investigation.
 */

import crypto from "node:crypto";
import type { Database } from "./db.js";
import type { NormalizedAlert } from "./models.js";

export const KEEP_SECONDS = 7 * 24 * 3600; // saved entries older than a week are dropped on startup

export interface DedupEntry {
  investigation_id: string;
  first_seen: number; // epoch seconds, like Python's time.time()
  count: number;
}

export function fingerprint(alert: NormalizedAlert): string {
  const key = [alert.source_id, alert.service, alert.title, alert.resource ?? ""].join("|");
  return crypto.createHash("sha256").update(key).digest("hex");
}

export type StateOf = (investigationId: string) => "open" | "closed" | null;

export class DedupCache {
  readonly ttlSeconds: number;
  entries: Map<string, DedupEntry>;

  constructor(
    ttlMinutes: number,
    private readonly clock: () => number = () => Date.now() / 1000,
    private readonly db: Database | null = null,
  ) {
    this.ttlSeconds = ttlMinutes * 60;
    this.entries = new Map();
  }

  /** Load saved entries (async because Postgres is). */
  async load(): Promise<this> {
    if (this.db) this.entries = await this.db.loadDedup(this.clock() - KEEP_SECONDS);
    return this;
  }

  /**
   * Returns [investigation_id, count, is_duplicate].
   * stateOf(id) -> "open" | "closed" | null (no longer kept). Without it, only the time window counts.
   */
  async check(fp: string, newInvestigationId: string, stateOf?: StateOf): Promise<[string, number, boolean]> {
    const now = this.clock();
    const entry = this.entries.get(fp);
    const state = entry && stateOf ? stateOf(entry.investigation_id) : "closed";
    const recent = entry !== undefined && now - entry.first_seen < this.ttlSeconds;

    if (entry && state !== null && (state === "open" || recent)) {
      entry.count += 1;
      await this.save(fp);
      return [entry.investigation_id, entry.count, true];
    }
    this.entries.set(fp, { investigation_id: newInvestigationId, first_seen: now, count: 1 });
    await this.save(fp);
    return [newInvestigationId, 1, false];
  }

  private async save(fp: string): Promise<void> {
    if (this.db) await this.db.saveDedup(fp, this.entries.get(fp)!);
  }
}
