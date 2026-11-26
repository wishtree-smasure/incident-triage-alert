/**
 * The sample shop (sample_app/shop.py, still Python): its three bugs, its warning, and the log
 * format the watcher reads. Each test runs a few lines of Python against the real shop.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseEntries } from "../src/logwatch.js";
import { PROJECT_ROOT } from "../src/settings.js";
import { hasPython, PYTHON } from "./shoplog.js";

/** Run Python with `shop` imported and good_order() defined; returns what it prints, parsed as JSON. */
function py(code: string, logPath?: string): any {
  const script = [
    "import json, logging, random, sys",
    `sys.path.insert(0, ${JSON.stringify(PROJECT_ROOT)})`,
    "from pathlib import Path",
    "from sample_app import shop",
    "def good_order(**changes):",
    "    return {'id': 1, 'total': 100.0, 'coupon': {'percent': 10}, 'shipping': 'standard', 'busy_connections': 5, **changes}",
    "def raises(f, *a):",
    "    try:",
    "        f(*a)",
    "    except Exception as e:",
    "        return [type(e).__name__, str(e)]",
    "    return None",
    logPath ? `shop.setup_logging(Path(${JSON.stringify(logPath)}))` : "",
    code,
  ].join("\n");
  const r = spawnSync(PYTHON, ["-c", script], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}
const tmpLog = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "shop-")), "logs", "shop.log");

describe.skipIf(!hasPython)("sample shop (Python)", () => {
  describe("business logic", () => {
    it("coupon discount", () => expect(py("print(shop.apply_coupon(good_order(coupon={'percent': 20})))")).toBe(80));
    it("standard shipping", () => expect(py("print(shop.shipping_cost('standard'))")).toBe(4.99));
    it("db connection under the limit", () => expect(py("print(json.dumps(shop.get_db_connection(shop.DB_POOL_SIZE - 1)))")).toBe("db-connection"));
    it("random order shape", () => {
      const order = py("print(json.dumps(shop.random_order(42)))");
      expect(order.id).toBe(42);
      expect(Object.keys(order).sort()).toEqual(["busy_connections", "coupon", "id", "shipping", "total"]);
      expect(["standard", "express"]).toContain(order.shipping);
    });
  });

  describe("the three bugs", () => {
    it("1: an order without a coupon crashes", () => {
      const [type, message] = py("print(json.dumps(raises(shop.apply_coupon, good_order(coupon=None))))");
      expect(type).toBe("TypeError");
      expect(message).toContain("NoneType");
    });
    it("2: the pool is exhausted at the limit", () => {
      const [type, message] = py("print(json.dumps(raises(shop.get_db_connection, shop.DB_POOL_SIZE)))");
      expect(type).toBe("TimeoutError");
      expect(message).toContain("connection pool exhausted");
    });
    it("3: the express rate is not a number", () => {
      const [type, message] = py("print(json.dumps(raises(shop.shipping_cost, 'express')))");
      expect(type).toBe("ValueError");
      expect(message).toContain("could not convert string to float");
    });
  });

  describe("logging", () => {
    it("a good order logs INFO", () => {
      const log = tmpLog();
      py("random.choice = lambda o: o[0]\nshop.process_order(good_order(id=7))\nprint('null')", log);
      const [entry] = parseEntries(fs.readFileSync(log, "utf8").trimEnd());
      expect(entry.level).toBe("INFO");
      expect(entry.message).toContain("Order 7 paid");
    });

    it("a slow order logs a WARNING first", () => {
      const log = tmpLog();
      py("random.choice = lambda o: o[-1]\nshop.process_order(good_order(id=8))\nprint('null')", log); // the 2500 ms path
      expect(parseEntries(fs.readFileSync(log, "utf8").trimEnd()).map((e) => e.level)).toEqual(["WARNING", "INFO"]);
    });

    it("a failed order's log has a stack trace the watcher can read", () => {
      const log = tmpLog();
      py("random.choice = lambda o: o[0]\ntry:\n    shop.process_order(good_order(id=9, coupon=None))\nexcept Exception:\n    shop.log.exception('Order %s failed', 9)\nprint('null')", log);
      const [entry] = parseEntries(fs.readFileSync(log, "utf8").trimEnd());
      expect(entry.level).toBe("ERROR");
      expect(entry.time.endsWith("Z")).toBe(true); // UTC
      expect(entry.trace[0]).toBe("Traceback (most recent call last):");
      expect(entry.trace.at(-1)!.startsWith("TypeError")).toBe(true);
    });

    it("setup_logging creates the folder", () => {
      const log = tmpLog();
      expect(py(`print(json.dumps([Path(${JSON.stringify(log)}).parent.is_dir(), shop.log.level == logging.INFO]))`, log)).toEqual([true, true]);
    });

    it("--log writes to the given file (used by demo mode)", () => {
      const log = tmpLog();
      fs.mkdirSync(path.dirname(log), { recursive: true });
      spawnSync("timeout", ["2", PYTHON, path.join(PROJECT_ROOT, "sample_app", "shop.py"), "--log", log, "--every", "0.05"]);
      expect(fs.readFileSync(log, "utf8")).toContain("shop.access");
    });
  });
});
