/**
 * Generate realistic API traffic for the last 24 hours and send it to the triage app.
 *
 * Usage (with the app running on localhost:8000):
 *   npm run generate-traffic
 *   npm run generate-traffic -- --hours 24 --scale 1.0 --seed 7
 *   npm run generate-traffic -- --file ../fixtures/traffic_24h.json   (send a saved traffic set instead)
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadRegistry } from "../src/registry.js";
import { sendCalls } from "../src/samples.js";
import { loadDotenv, PROJECT_ROOT } from "../src/settings.js";
import { APPS, generate } from "../src/trafficgen.js";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8000" },
    hours: { type: "string", default: "24" },
    scale: { type: "string", default: "1.0" },
    seed: { type: "string", default: "7" },
    file: { type: "string" },
  },
});
loadDotenv();
const registry = loadRegistry(path.join(PROJECT_ROOT, "config", "sources.yaml"));
const calls = values.file
  ? JSON.parse(fs.readFileSync(values.file, "utf8"))
  : generate(new Date(), Number(values.hours), Number(values.scale), Number(values.seed));
const statuses = await sendCalls(values.url!, registry, calls);
const apps = new Set(calls.map((c: { app: string }) => c.app)).size || Object.keys(APPS).length;
console.log(`Sent ${calls.length.toLocaleString("en-US")} API calls for ${apps} applications in ${statuses.length} batches: ${JSON.stringify(statuses)}`);
