/** Schemas (alert, verdict, investigation) and the in-memory store. */

import { describe, expect, it } from "vitest";
import { Investigation, NormalizedAlertSchema, VerdictSchema } from "../src/models.js";
import { InvestigationStore, MAX_ITEMS } from "../src/store.js";

const makeAlert = (changes: Record<string, unknown> = {}) =>
  NormalizedAlertSchema.parse({ source_id: "s", source_type: "generic", service: "app", title: "t", fired_at: "2026-11-20T06:00:00Z", ...changes });
const makeVerdict = (changes: Record<string, unknown> = {}) => ({
  investigation_id: "i", status: "concluded", severity: "SEV1", category: "deployment", summary: "s", root_cause: "r",
  confidence: "high", evidence: [{ claim: "c", tool_call_id: "tc_1" }], ...changes,
});

describe("alert", () => {
  it("time without a time zone is treated as UTC", () => {
    expect(makeAlert({ fired_at: "2026-11-20T06:00:00" }).fired_at.toISOString()).toBe("2026-11-20T06:00:00.000Z");
  });
  it("other time zones are converted to UTC", () => {
    expect(makeAlert({ fired_at: "2026-11-20T11:30:00+05:30" }).fired_at.toISOString()).toBe("2026-11-20T06:00:00.000Z");
  });
  it("invalid severity hint rejected", () => expect(() => makeAlert({ severity_hint: "SEV9" })).toThrow());
});

describe("verdict", () => {
  it("valid", () => expect(VerdictSchema.parse(makeVerdict()).evidence[0].tool_call_id).toBe("tc_1"));
  it("a concluded verdict needs evidence", () => expect(() => VerdictSchema.parse(makeVerdict({ evidence: [] }))).toThrow(/evidence/));
  for (const status of ["inconclusive", "failed"]) {
    it(`an unfinished verdict (${status}) may have no evidence`, () => {
      expect(VerdictSchema.parse(makeVerdict({ status, evidence: [] })).status).toBe(status);
    });
  }
  for (const [field, value] of [["severity", "SEV0"], ["category", "network"], ["confidence", "certain"], ["status", "done"]]) {
    it(`rejects unknown ${field}`, () => expect(() => VerdictSchema.parse(makeVerdict({ [field]: value }))).toThrow());
  }
});

describe("investigation severity / level", () => {
  for (const [hint, level] of [["SEV1", "alert"], ["SEV2", "alert"], [null, "alert"], ["SEV3", "warning"], ["SEV4", "warning"]] as const) {
    it(`${hint} is ${level}`, () => {
      expect(new Investigation({ id: "i", source_id: "s", service: "app", alert: makeAlert({ severity_hint: hint }) }).level).toBe(level);
    });
  }
  it("verdict severity overrides the monitoring tool", () => {
    const inv = new Investigation({ id: "i", source_id: "s", service: "app", alert: makeAlert({ severity_hint: "SEV4" }) });
    inv.verdict = VerdictSchema.parse(makeVerdict({ severity: "SEV1" }));
    expect([inv.severity, inv.level]).toEqual(["SEV1", "alert"]);
  });
  it("saved JSON has the Python app's field names and reads back", () => {
    const inv = new Investigation({ id: "i", source_id: "s", service: "app", alert: makeAlert() });
    const json = JSON.parse(JSON.stringify(inv));
    expect(Object.keys(json).sort()).toEqual(["alert", "created_at", "dedup_count", "id", "service", "source_id", "status", "suggestion", "trace", "verdict"]);
    expect(Investigation.fromJSON(JSON.stringify(inv)).alert.fired_at).toEqual(inv.alert.fired_at);
  });
  it("reads JSON written by the Python app (microseconds, Z suffix)", () => {
    const inv = Investigation.fromJSON(JSON.stringify({
      id: "py1", source_id: "s", service: "app", status: "queued", created_at: "2026-11-24T10:45:20.558268Z", dedup_count: 3,
      trace: [], suggestion: null, verdict: null,
      alert: { source_id: "s", source_type: "generic", service: "app", title: "t", description: "", severity_hint: "SEV2",
        fired_at: "2026-11-20T06:00:00Z", resource: null, labels: {}, raw: {} },
    }));
    expect(inv.created_at.toISOString()).toBe("2026-11-24T10:45:20.558Z");
    expect(inv.dedup_count).toBe(3);
  });
});

describe("store", () => {
  const make = (n: number) => new Investigation({ id: `inv-${n}`, source_id: "s", service: "app", alert: makeAlert() });

  it("get and order", async () => {
    const store = new InvestigationStore();
    for (let n = 0; n < 3; n++) await store.add(make(n));
    expect(store.get("inv-1")!.id).toBe("inv-1");
    expect(store.get("missing")).toBeUndefined();
    expect(store.newestFirst().map((i) => i.id)).toEqual(["inv-2", "inv-1", "inv-0"]);
  });

  it(`keeps only the newest ${MAX_ITEMS}`, async () => {
    const store = new InvestigationStore();
    for (let n = 0; n < MAX_ITEMS + 5; n++) await store.add(make(n));
    expect(store.items.size).toBe(MAX_ITEMS);
    expect(store.get("inv-0")).toBeUndefined(); // oldest dropped
    expect(store.get(`inv-${MAX_ITEMS + 4}`)).toBeDefined();
  });
});
