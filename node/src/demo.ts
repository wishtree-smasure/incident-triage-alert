/**
 * Demo mode: run the sample shop and the log watcher alongside the web app.
 *
 * A deployed instance (e.g. on Render) runs only the web server, so nothing would ever send it
 * alerts. With DEMO_MODE=true the app, once listening:
 *   - starts the Python sample shop (sample_app/shop.py) as a child process, writing real
 *     errors / warnings / API calls to a log file; it needs python3 (the Docker image has it)
 *   - watches that log every few seconds and sends what it finds, signed, to its own
 *     /hooks and /requests endpoints
 * On a fresh start (nothing saved yet) it also sends the Datadog / AWS / Azure samples and
 * 24 hours of API traffic for every sample application, so every tab has something to show.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppState } from "./app.js";
import { checkOnce, LogTail, SOURCE_ID } from "./logwatch.js";
import { sendAll, sendCalls } from "./samples.js";
import { PROJECT_ROOT } from "./settings.js";
import { generate } from "./trafficgen.js";

export interface DemoOptions {
  logPath?: string;
  every?: number; // seconds between log checks
  python?: string;
}

/** Start the sample shop. Returns the child process, or null when Python is not available. */
export function startShop(logPath: string, python = process.env.PYTHON ?? "python3"): ChildProcess | null {
  const script = path.join(PROJECT_ROOT, "sample_app", "shop.py");
  const child = spawn(python, [script, "--log", logPath], { stdio: ["ignore", "ignore", "inherit"] });
  child.on("error", (e) => console.error(`demo: cannot start the sample shop with ${python} (${e.message}); alerts from it are off`));
  return child;
}

/** Start the demo. Returns a function that stops it. */
export function start(state: AppState, baseUrl: string, opts: DemoOptions = {}): () => void {
  const logPath = opts.logPath ?? path.join(os.tmpdir(), "triage-demo", "shop.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, ""); // start from an empty log on every boot

  // Only on a fresh start: with a database, a redeploy keeps what is there.
  let sendSamples = state.store.items.size === 0;
  let sendTraffic = state.traffic.calls.length === 0;

  const shop = startShop(logPath, opts.python);
  const tail = new LogTail(logPath);
  const secret = state.registry.secretFor(SOURCE_ID);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return; // a slow check (e.g. the first one, with the seeding) is still running
    busy = true;
    try {
      if (sendSamples) {
        await sendAll(baseUrl, state.registry);
        sendSamples = false;
      }
      if (sendTraffic) {
        await sendCalls(baseUrl, state.registry, generate(new Date(), 24, 0.5));
        sendTraffic = false;
      }
      await checkOnce(tail, baseUrl, secret, "sample-shop");
    } catch (e) {
      console.error(`demo watcher: ${(e as Error).message}`); // keep the demo running whatever happens
    } finally {
      busy = false;
    }
  }, (opts.every ?? 5) * 1000);

  return () => {
    clearInterval(timer);
    shop?.kill();
  };
}
