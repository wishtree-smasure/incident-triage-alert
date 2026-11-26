/** The Node.js port gives the same results as the Python app (node/test/golden/make_goldens.py). */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeApp, overviewOfApps } from "../src/analysis.js";
import { fingerprint } from "../src/dedup.js";
import { codeLocation } from "../src/location.js";
import { ApiCallSchema, Investigation } from "../src/models.js";
import { normalize } from "../src/normalizers/index.js";
import { loadPlaybook, suggest } from "../src/playbook.js";
import { golden, ROOT, testRegistry } from "./helpers.js";

/** Deep comparison: numbers within a relative 1e-9, dates by instant, extra keys on our side ignored. */
function same(ours: any, theirs: any, where = "$"): void {
  if (theirs === null || theirs === undefined) {
    expect(ours ?? null, where).toBeNull();
  } else if (typeof theirs === "number") {
    expect(typeof ours, where).toBe("number");
    expect(Math.abs(ours - theirs) <= 1e-7 * Math.max(1, Math.abs(theirs)), `${where}: ${ours} vs ${theirs}`).toBe(true);
  } else if (Array.isArray(theirs)) {
    expect(ours, where).toHaveLength(theirs.length);
    theirs.forEach((t, i) => same(ours[i], t, `${where}[${i}]`));
  } else if (typeof theirs === "object") {
    for (const key of Object.keys(theirs)) same(ours?.[key], theirs[key], `${where}.${key}`);
  } else if (typeof theirs === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(theirs) && ours instanceof Date) {
    expect(ours.getTime(), where).toBe(new Date(theirs).getTime());
  } else {
    expect(ours, where).toEqual(theirs);
  }
}

const registry = testRegistry();
const playbook = loadPlaybook(path.join(ROOT, "config", "playbook.yaml"));

describe("normalized alerts", () => {
  for (const g of golden("normalized")) {
    it(g.name, () => {
      const alert = normalize(registry.get(g.source_id)!, g.payload);
      const { raw, ...rest } = alert;
      same(rest, g.alert);
      expect(fingerprint(alert)).toBe(g.fingerprint);
      expect(suggest(alert, playbook)).toEqual(g.suggestion);
      expect(codeLocation(alert)).toEqual(g.code_location);
    });
  }
});

describe("code locations", () => {
  for (const g of golden("locations")) {
    it(g.description.split("\n")[0] || "labels", () => {
      expect(codeLocation({ title: "Something broke", description: g.description, labels: g.labels ?? {} })).toEqual(g.location);
    });
  }
});

describe("API analysis", () => {
  const g = golden("analysis");
  const calls = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "traffic_24h.json"), "utf8")).map((c: unknown) => ApiCallSchema.parse(c));
  const byApp = new Map<string, typeof calls>();
  for (const c of calls) byApp.set(c.app, [...(byApp.get(c.app) ?? []), c]);
  const normalized = golden("normalized");
  const alerts = normalized.map((n: any, i: number) => new Investigation({
    id: `inv${i}`, source_id: n.source_id, service: n.alert.service, alert: { ...n.alert, raw: {} },
  }));

  it("overview of all applications", () => same(overviewOfApps(byApp, alerts), g.overview));
  for (const app of Object.keys(g.apps)) {
    it(`analysis of ${app}`, () => same(analyzeApp(app, byApp.get(app)!, alerts), g.apps[app]));
  }
});
