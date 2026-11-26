/** Every sample is accepted, and the whole demo flow: shop writes errors -> watcher -> app -> dashboard. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import * as demo from "../src/demo.js";
import { checkOnce, LogTail } from "../src/logwatch.js";
import { sendAll } from "../src/samples.js";
import { loadSamples, makeApp, postSigned, TEST_SECRETS, testRegistry } from "./helpers.js";
import { hasPython, runShop } from "./shoplog.js";

it("all samples are accepted", async () => {
  const app = await makeApp();
  for (const sample of loadSamples()) {
    for (let i = 0; i < (sample.repeat ?? 1); i++) {
      const r = await postSigned(app, sample.source_id, sample.payload);
      expect(r.statusCode, `${sample.note}: ${r.body}`).toBe(202);
    }
  }
  const investigations = app.state.store.newestFirst();
  expect(investigations).toHaveLength(loadSamples().length); // the repeated one was de-duplicated
  expect(new Set(investigations.map((i) => i.level))).toEqual(new Set(["alert", "warning"]));
  await app.close();
});

it("the send-samples script loads the dashboard", async () => {
  const app = await makeApp();
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  const results = await sendAll(url, testRegistry());
  expect(results.length).toBeGreaterThan(0);
  expect(results.every(([status]) => status === 202)).toBe(true);
  const page = (await app.inject("/")).body;
  expect(page).toContain("Show stoppers ·");
  for (const name of ["Datadog prod", "AWS prod", "Azure prod", "In-house logs"]) expect(page).toContain(name);
  await app.close();
});

it.skipIf(!hasPython)("the shop's bugs reach the dashboard with where and fix (real Python shop)", async () => {
  const app = await makeApp();
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  // One of each bug, plus a good order; then the coupon bug again.
  const log = runShop([{}, { coupon: null }, { busy_connections: 20 }, { shipping: "express" }, { coupon: null }]);
  const results = await checkOnce(new LogTail(log), url, TEST_SECRETS.SRC_GENERIC_SECRET, "sample-shop");
  expect(results.filter((r) => r.startsWith("202")).length).toBeGreaterThanOrEqual(4);

  const page = (await app.inject("/?app=sample-shop")).body;
  for (const [title, fix] of [
    ["TypeError in apply_coupon()", "Check for None"],
    ["TimeoutError in get_db_connection()", "Find connections that are not released"],
    ["ValueError in shipping_cost()", "Correct the value in the config"],
  ]) {
    expect(page).toContain(title);
    expect(page).toContain(fix);
  }
  expect(page.split("<code>sample_app/shop.py:").length - 1).toBe(3);
  const coupon = app.state.store.newestFirst().find((i) => i.alert.title.includes("apply_coupon"))!;
  expect(coupon.dedup_count).toBe(2);
  expect(coupon.alert.resource).toMatch(/^sample_app\/shop\.py:\d+$/);
  expect(coupon.alert.labels.function).toBe("apply_coupon");
  await app.close();
});

it.skipIf(!hasPython)("demo mode: shop, samples, traffic and log alerts all arrive", async () => {
  const app = await makeApp();
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "demo-")), "shop.log");
  const stop = demo.start(app.state, url, { logPath, every: 0.3 });
  try {
    await expect.poll(() => app.state.store.items.size > loadSamples().length - 1, { timeout: 15000, interval: 200 }).toBe(true);
    await expect.poll(() => app.state.traffic.apps().length, { timeout: 15000, interval: 200 }).toBe(7);
    await expect.poll(() => app.state.store.newestFirst().some((i) => i.service === "sample-shop"), { timeout: 15000, interval: 300 }).toBe(true);
    expect(fs.readFileSync(logPath, "utf8")).toContain("shop.access");
  } finally {
    stop();
    await app.close();
  }
}, 30000);

it("demo mode does not reload samples into a database that already has alerts", async () => {
  const app = await makeApp();
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  await postSigned(app, "inhouse-app", { title: "already here", fired_at: "2026-11-20T06:00:00Z" });
  await app.state.traffic.add([]);
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "demo-")), "shop.log");
  const stop = demo.start(app.state, url, { logPath, every: 0.2, python: "definitely-not-python" });
  await new Promise((r) => setTimeout(r, 800));
  stop();
  expect(app.state.store.newestFirst().filter((i) => i.source_id === "datadog-prod")).toHaveLength(0);
  await app.close();
});
