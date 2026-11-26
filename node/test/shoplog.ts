/** Runs the real Python sample shop for a few chosen customers and returns its log, or null without python3. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_ROOT } from "../src/settings.js";

export const PYTHON = process.env.PYTHON ?? "python3";
export const hasPython = spawnSync(PYTHON, ["--version"]).status === 0;

/** orders: one per customer, merged into a good default order (coupon null = the coupon bug). */
export function runShop(orders: Record<string, unknown>[]): string {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "shop-")), "shop.log");
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(PROJECT_ROOT)})
from sample_app import shop
orders = json.loads(sys.argv[2])
base = {"total": 10.0, "coupon": {"percent": 10}, "shipping": "standard", "busy_connections": 5}
it = iter(orders)
shop.random_order = lambda n: {**base, "id": n, **next(it)}
shop.setup_logging(__import__("pathlib").Path(sys.argv[1]))
for n in range(1, len(orders) + 1):
    shop.serve_customer(n)
`;
  const r = spawnSync(PYTHON, ["-c", script, log, JSON.stringify(orders)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return log;
}
