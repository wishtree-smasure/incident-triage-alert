/**
 * Send the sample incidents and warnings in fixtures/sample_alerts.json to the running app.
 *
 * Usage (with the app running on localhost:8000):
 *   npm run send-samples
 *   npm run send-samples -- --url http://localhost:8000
 */

import { parseArgs } from "node:util";
import path from "node:path";
import { loadRegistry } from "../src/registry.js";
import { sendAll } from "../src/samples.js";
import { loadDotenv, PROJECT_ROOT } from "../src/settings.js";

const { values } = parseArgs({ options: { url: { type: "string", default: "http://localhost:8000" } } });
loadDotenv();
const registry = loadRegistry(path.join(PROJECT_ROOT, "config", "sources.yaml"));
for (const [status, note] of await sendAll(values.url!, registry)) console.log(`${status}  ${note}`);
