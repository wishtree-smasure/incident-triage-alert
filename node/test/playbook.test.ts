import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { parseEntries, toAlert } from "../src/logwatch.js";
import { normalize } from "../src/normalizers/index.js";
import { loadPlaybook, suggest, type Rule } from "../src/playbook.js";
import { PROJECT_ROOT } from "../src/settings.js";
import { loadSamples, makeApp, postSigned, testRegistry } from "./helpers.js";
import { LOG } from "./watchlogs.test.js";

const PLAYBOOK = loadPlaybook(path.join(PROJECT_ROOT, "config", "playbook.yaml"));
const registry = testRegistry();
const rule = (match: string, cause: string, fix: string): Rule => ({ match, cause, fix, immediate: "", pattern: new RegExp(match, "i") });
const make = (title: string) => normalize(registry.get("inhouse-app")!, { title, fired_at: "2026-11-20T06:00:00Z" });
const writePlaybook = (text: string) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pb-")), "playbook.yaml");
  fs.writeFileSync(file, text);
  return file;
};

it("every sample alert gets a suggestion", () => {
  for (const sample of loadSamples()) {
    const alert = normalize(registry.get(sample.source_id)!, sample.payload);
    expect(suggest(alert, PLAYBOOK), sample.note).not.toBeNull();
  }
});

it("shop coupon bug gets the None-check fix", () => {
  const alert = normalize(registry.get("inhouse-app")!, toAlert(parseEntries(LOG)[1]));
  expect(suggest(alert, PLAYBOOK)!.fix).toContain("None");
});

it("first matching rule wins", () => {
  const alert = normalize(registry.get("datadog-prod")!, loadSamples()[0].payload);
  expect(suggest(alert, [rule("5xx", "first", "a"), rule("checkout", "second", "b")])!.cause).toBe("first");
});

it("no match returns null", () => expect(suggest(make("something new"), PLAYBOOK)).toBeNull());

it("broken pattern fails at load", () => {
  expect(() => loadPlaybook(writePlaybook("rules:\n  - {match: '([', cause: c, fix: f}\n"))).toThrow();
});

it("fix is shown on the dashboard and the detail page", async () => {
  const app = await makeApp();
  const id = (await postSigned(app, "inhouse-app", toAlert(parseEntries(LOG)[1]))).json().investigation_id;
  expect((await app.inject("/")).body).toContain("Check for None");
  const page = (await app.inject(`/investigations/${id}`)).body;
  for (const text of ["Likely cause:", "Immediate action:", "Proper fix:", "sample-shop"]) expect(page).toContain(text);
  await app.close();
});

it("matching ignores case", () => expect(suggest(make("DISK USAGE above 90%"), PLAYBOOK)).not.toBeNull());

it("immediate falls back to fix", () => expect(suggest(make("boom"), [rule("boom", "c", "the fix")])!.immediate).toBe("the fix"));

it("matches the error label and the description", () => {
  const alert = normalize(registry.get("inhouse-app")!, {
    title: "Generic title", fired_at: "2026-11-20T06:00:00Z", description: "... connection pool exhausted (20/20 in use)",
  });
  expect(suggest(alert, PLAYBOOK)!.cause).toContain("database connections");
});

it("every rule has cause, immediate and fix", () => {
  for (const r of PLAYBOOK) expect(Boolean(r.cause && r.immediate && r.fix), r.match).toBe(true);
});

it("rule missing a field fails at load", () => {
  expect(() => loadPlaybook(writePlaybook("rules:\n  - {match: 'x', cause: c}\n"))).toThrow(/fix/);
});
