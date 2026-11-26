/**
 * Watch a log file and send its errors, warnings and API calls to the triage app.
 *
 * Usage (with the app running on localhost:8000 and the shop writing its log):
 *   python sample_app/shop.py
 *   npm run watch-logs
 *   npm run watch-logs -- --log ../sample_app/logs/shop.log --every 5
 */

import path from "node:path";
import { parseArgs } from "node:util";
import { checkOnce, LogTail, SOURCE_ID } from "../src/logwatch.js";
import { loadRegistry } from "../src/registry.js";
import { loadDotenv, PROJECT_ROOT } from "../src/settings.js";

const { values } = parseArgs({
  options: {
    log: { type: "string", default: path.join(PROJECT_ROOT, "sample_app", "logs", "shop.log") },
    url: { type: "string", default: "http://localhost:8000" },
    every: { type: "string", default: "5" },
    service: { type: "string", default: "sample-shop" },
  },
});
loadDotenv();
const secret = loadRegistry(path.join(PROJECT_ROOT, "config", "sources.yaml")).secretFor(SOURCE_ID);
console.log(`Watching ${values.log} every ${values.every}s (Ctrl+C to stop)`);
const tail = new LogTail(values.log!);
for (;;) {
  for (const line of await checkOnce(tail, values.url!, secret, values.service!)) console.log(line);
  await new Promise((r) => setTimeout(r, Number(values.every) * 1000));
}
