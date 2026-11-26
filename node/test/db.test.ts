/** Saved data survives a restart: alerts, repeat counts, API calls and de-duplication. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Database } from "../src/db.js";
import { DedupCache } from "../src/dedup.js";
import { ApiCallSchema } from "../src/models.js";
import { loadSettings, PROJECT_ROOT } from "../src/settings.js";
import { makeApp, postSigned } from "./helpers.js";

const ALERT = { title: "Disk full", service: "billing-service", severity: "SEV2", fired_at: "2026-11-20T06:00:00Z" };
const POSTGRES = process.env.TEST_POSTGRES_URL;

async function freshUrl(kind: "sqlite" | "postgres"): Promise<string> {
  if (kind === "sqlite") return `sqlite:///${path.join(fs.mkdtempSync(path.join(os.tmpdir(), "db-")), "triage.db")}`;
  const db = await Database.open(POSTGRES!, PROJECT_ROOT);
  for (const table of ["investigations", "api_calls", "dedup"]) await db.run(`DELETE FROM ${table}`);
  await db.close();
  return POSTGRES!;
}

for (const kind of ["sqlite", "postgres"] as const) {
  describe.skipIf(kind === "postgres" && !POSTGRES)(`${kind} (set TEST_POSTGRES_URL to test Postgres)`, () => {
    it("alerts and API calls survive a restart", async () => {
      const url = await freshUrl(kind);
      let c = await makeApp({ database_url: url });
      const first = (await postSigned(c, "inhouse-app", ALERT)).json();
      await postSigned(c, "inhouse-app", ALERT); // a repeat
      const call = { app: "billing-service", method: "GET", path: "/plans", status: 200, duration_ms: 12.5, time: "2026-11-20T06:00:00Z" };
      await postSigned(c, "inhouse-app", { calls: [call] }, { endpoint: "requests" });
      await c.close();

      c = await makeApp({ database_url: url }); // "redeploy"
      const inv = c.state.store.get(first.investigation_id)!;
      expect([inv.alert.title, inv.dedup_count]).toEqual(["Disk full", 2]);
      expect(c.state.traffic.apps()).toEqual(["billing-service"]);
      expect((await c.inject("/")).body).toContain("Disk full");
      // The same alert after the restart is still merged into the saved one.
      const again = (await postSigned(c, "inhouse-app", ALERT)).json();
      expect([again.investigation_id, again.dedup_count]).toEqual([first.investigation_id, 3]);
      await c.close();
    });

    it("only the newest API calls are kept", async () => {
      const db = await Database.open(await freshUrl(kind), PROJECT_ROOT);
      const calls = Array.from({ length: 10 }, (_, n) =>
        ApiCallSchema.parse({ app: "a", method: "GET", path: `/${n}`, status: 200, duration_ms: 1, time: "2026-11-20T00:00:00Z" }));
      await db.addCalls(calls.slice(0, 6), 4);
      await db.addCalls(calls.slice(6), 4);
      expect((await db.loadCalls(100)).map((c) => c.path)).toEqual(["/6", "/7", "/8", "/9"]);
      await db.close();
    });

    it("dedup entries survive a restart until a week old", async () => {
      const db = await Database.open(await freshUrl(kind), PROJECT_ROOT);
      const now = 1_000_000;
      await new DedupCache(15, () => now, db).check("fp", "inv1");
      // Past the 15-minute window but still kept: an open investigation keeps its count after a redeploy.
      expect((await new DedupCache(15, () => now + 3600, db).load()).entries.has("fp")).toBe(true);
      expect((await new DedupCache(15, () => now + 8 * 24 * 3600, db).load()).entries.size).toBe(0);
      await db.close();
    });

    it("an open alert keeps counting after a restart", async () => {
      const url = await freshUrl(kind);
      let c = await makeApp({ database_url: url, dedup_ttl_min: 0 }); // window 0: only "open" merges
      const first = (await postSigned(c, "inhouse-app", ALERT)).json();
      await c.close();
      c = await makeApp({ database_url: url, dedup_ttl_min: 0 });
      const again = (await postSigned(c, "inhouse-app", ALERT)).json();
      expect([again.investigation_id, again.dedup_count]).toEqual([first.investigation_id, 2]);
      c.state.store.get(first.investigation_id)!.status = "concluded";
      const third = (await postSigned(c, "inhouse-app", ALERT)).json();
      expect(third.investigation_id).not.toBe(first.investigation_id);
      expect(third.deduplicated).toBe(false);
      await c.close();
    });
  });
}

it("the default database is a local file", () => {
  expect(loadSettings({}, {}).database_url).toBe("sqlite:///data/triage.db");
});

it("a bad DATABASE_URL stops startup", async () => {
  await expect(Database.open("mysql://x", PROJECT_ROOT)).rejects.toThrow(/DATABASE_URL/);
});
