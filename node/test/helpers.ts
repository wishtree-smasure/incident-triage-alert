import fs from "node:fs";
import path from "node:path";
import { createApp } from "../src/app.js";
import { loadRegistry } from "../src/registry.js";
import { PROJECT_ROOT, loadSettings, type Settings } from "../src/settings.js";
import { sign } from "../src/security.js";

export const TEST_SECRETS: Record<string, string> = {
  SRC_DATADOG_SECRET: "dd-secret",
  SRC_CLOUDWATCH_SECRET: "cw-secret",
  SRC_AZURE_SECRET: "az-secret",
  SRC_GENERIC_SECRET: "gen-secret",
};
export const SECRET_ENV: Record<string, string> = {
  "datadog-prod": "SRC_DATADOG_SECRET",
  "cloudwatch-prod": "SRC_CLOUDWATCH_SECRET",
  "azure-prod": "SRC_AZURE_SECRET",
  "inhouse-app": "SRC_GENERIC_SECRET",
};

export const ROOT = PROJECT_ROOT;
export const readJson = (...parts: string[]) => JSON.parse(fs.readFileSync(path.join(...parts), "utf8"));
export const loadPayload = (name: string) => readJson(ROOT, "node", "test", "payloads", `${name}.json`);
export const golden = (name: string) => readJson(ROOT, "node", "test", "golden", `${name}.json`);

/** The real config/sources.yaml, with test secrets. */
export const testRegistry = () => loadRegistry(path.join(ROOT, "config", "sources.yaml"), TEST_SECRETS);

/** An app whose settings ignore the developer's .env (memory only unless a database_url is given). */
export async function makeApp(overrides: Partial<Settings> = {}) {
  const settings = loadSettings({ database_url: "", demo_mode: false, ...overrides }, {});
  return createApp({ registry: testRegistry(), settings });
}
export type TestApp = Awaited<ReturnType<typeof makeApp>>;

/** POST a payload to /<endpoint>/<source_id>, signed with that source's test secret. */
export function postSigned(app: TestApp, sourceId: string, payload: unknown, opts: { endpoint?: string; secret?: string; signature?: string | null } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
  const secret = opts.secret ?? TEST_SECRETS[SECRET_ENV[sourceId] ?? "SRC_GENERIC_SECRET"];
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.signature !== null) headers["x-signature"] = opts.signature ?? sign(secret, body);
  return app.inject({ method: "POST", url: `/${opts.endpoint ?? "hooks"}/${sourceId}`, payload: body, headers });
}

/** The sample incidents in fixtures/sample_alerts.json (CloudWatch's Message as a JSON string, like SNS). */
export function loadSamples(): { source_id: string; payload: any; repeat?: number; note: string }[] {
  const samples = readJson(ROOT, "fixtures", "sample_alerts.json");
  for (const s of samples) {
    if (s.payload.Message && typeof s.payload.Message === "object") s.payload.Message = JSON.stringify(s.payload.Message);
  }
  return samples;
}
