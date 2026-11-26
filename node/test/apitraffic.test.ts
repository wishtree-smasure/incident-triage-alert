/** API calls end to end: /requests, the traffic store, the generator, the shop's access log, the analysis tab. */

import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkOnce, LogTail, parseEntries, toApiCall } from "../src/logwatch.js";
import { ApiCallSchema } from "../src/models.js";
import { sendCalls } from "../src/samples.js";
import { TrafficStore } from "../src/traffic.js";
import { APPS, busyness, generate, hoursApart } from "../src/trafficgen.js";
import { makeApp, postSigned, TEST_SECRETS, testRegistry, type TestApp } from "./helpers.js";
import { hasPython, runShop } from "./shoplog.js";

const NOW = new Date(Date.UTC(2026, 10, 23, 12, 0));
const SECRET = TEST_SECRETS.SRC_GENERIC_SECRET;
const apiCall = (changes: Record<string, unknown> = {}) => ({
  app: "shop", method: "GET", path: "/products", status: 200, duration_ms: 42.0, time: "2026-11-23T10:00:00Z", ...changes,
});
const postCalls = (app: TestApp, payload: unknown) => postSigned(app, "inhouse-app", payload, { endpoint: "requests" });

describe("POST /requests/:source", () => {
  let app: TestApp;
  beforeEach(async () => (app = await makeApp()));
  afterEach(() => app.close());

  it("accepts a signed batch", async () => {
    const r = await postCalls(app, { calls: [apiCall(), apiCall({ path: "/cart" })] });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ accepted: 2 });
    expect(app.state.traffic.calls).toHaveLength(2);
  });

  it("rejects an unknown source and a bad signature", async () => {
    const payload = JSON.stringify({ calls: [apiCall()] });
    expect((await app.inject({ method: "POST", url: "/requests/nope", payload })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/requests/inhouse-app", payload, headers: { "x-signature": "bad" } })).statusCode).toBe(401);
    expect(app.state.traffic.calls).toHaveLength(0);
  });

  for (const payload of [{ calls: [apiCall({ status: 999 })] }, { calls: [apiCall({ duration_ms: -1 })] }, { calls: [{ app: "shop" }] }, { nothing: [] }, []]) {
    it(`rejects a bad batch: ${JSON.stringify(payload).slice(0, 60)}`, async () => {
      expect((await postCalls(app, payload)).statusCode).toBe(422);
      expect(app.state.traffic.calls).toHaveLength(0);
    });
  }

  it("rejects a too-large batch", async () => {
    expect((await postCalls(app, { calls: Array.from({ length: 10_001 }, () => apiCall()) })).statusCode).toBe(422);
  });
});

it("method uppercased and time in UTC", () => {
  const c = ApiCallSchema.parse({ ...apiCall({ method: "get" }), time: "2026-11-23T10:00:00" });
  expect(c.method).toBe("GET");
  expect(c.time.toISOString()).toBe("2026-11-23T10:00:00.000Z");
});

it("the traffic store keeps the newest", async () => {
  const store = new TrafficStore(3);
  await store.add(Array.from({ length: 5 }, (_, i) => ApiCallSchema.parse(apiCall({ app: `a${i}` }))));
  expect(store.calls.map((c) => c.app)).toEqual(["a2", "a3", "a4"]);
  expect(store.apps()).toEqual(["a2", "a3", "a4"]);
  expect(store.forApp("a3")).toHaveLength(1);
});

describe("generator", () => {
  it("is repeatable and realistic", () => {
    const calls = generate(NOW, 24, 0.1, 1);
    expect(calls).toEqual(generate(NOW, 24, 0.1, 1));
    expect(new Set(calls.map((c) => c.app))).toEqual(new Set(Object.keys(APPS)));
    const times = calls.map((c) => Date.parse(c.time));
    expect(Math.min(...times)).toBeGreaterThanOrEqual(NOW.getTime() - 24 * 3600_000);
    expect(Math.max(...times)).toBeLessThanOrEqual(NOW.getTime());
    for (const c of calls.slice(0, 500)) ApiCallSchema.parse(c); // valid records
  });

  it("has all 7 sample applications", () => expect(Object.keys(APPS)).toHaveLength(7));

  it("follows the daily curve", () => {
    expect(busyness(13)).toBeGreaterThan(busyness(4));
    expect(busyness(2, 2)).toBeGreaterThan(busyness(14, 2));
    expect(hoursApart(23, 1)).toBe(2);
  });

  it("sends in signed batches", async () => {
    const app = await makeApp();
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const calls = generate(NOW, 24, 0.2, 1);
    const statuses = await sendCalls(url, testRegistry(), calls);
    expect(statuses).toHaveLength(Math.ceil(calls.length / 5000));
    expect(new Set(statuses)).toEqual(new Set([202]));
    expect(app.state.traffic.calls).toHaveLength(calls.length);
    await app.close();
  });
});

describe("shop access log -> watcher", () => {
  it("an access line becomes an API call", () => {
    const [entry] = parseEntries("2026-11-23T10:00:00Z INFO shop.access GET /products/7 200 37ms");
    expect(toApiCall(entry, "sample-shop")).toEqual({
      app: "sample-shop", method: "GET", path: "/products/7", status: 200, duration_ms: 37, time: "2026-11-23T10:00:00Z",
    });
  });

  for (const line of ["2026-11-23T10:00:00Z INFO shop Order 5 paid 10.00", "2026-11-23T10:00:00Z INFO shop.access something unexpected"]) {
    it(`not an API call: ${line}`, () => expect(toApiCall(parseEntries(line)[0])).toBeNull());
  }

  it.skipIf(!hasPython)("a shop visit logs API calls (real Python shop)", () => {
    const log = runShop([{ coupon: null }]); // coupon bug -> checkout fails
    const calls = parseEntries(fs.readFileSync(log, "utf8")).map((e) => toApiCall(e)).filter((c) => c !== null);
    expect(calls.map((c) => [c!.method, c!.status])).toEqual([["GET", 200], ["GET", 200], ["POST", 200], ["POST", 500]]);
    expect(calls.at(-1)!.path).toBe("/checkout");
  });

  it.skipIf(!hasPython)("the watcher forwards API calls and errors from the real Python shop", async () => {
    const log = runShop([{}, { coupon: null }, {}, { coupon: null }]);
    const app = await makeApp();
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const results = await checkOnce(new LogTail(log), url, SECRET, "sample-shop");
    expect(results.some((r) => r.includes("TypeError in apply_coupon()"))).toBe(true);
    expect(results.some((r) => /^202 {2}API\s+\d+ API calls/.test(r))).toBe(true);
    const checkout = app.state.traffic.forApp("sample-shop").filter((c) => c.path === "/checkout");
    expect(checkout).toHaveLength(4);
    expect(checkout.filter((c) => c.status === 500)).toHaveLength(2);
    // The location points at the shop's real file.
    const inv = app.state.store.newestFirst().find((i) => i.alert.title === "TypeError in apply_coupon()")!;
    expect(inv.alert.resource).toMatch(/^sample_app\/shop\.py:\d+$/);
    await app.close();
  });
});

describe("the API analysis tab", () => {
  let loaded: TestApp;
  beforeAll(async () => {
    loaded = await makeApp();
    await loaded.state.traffic.add(generate(NOW, 24, 0.05, 3).map((c) => ApiCallSchema.parse(c)));
  });
  afterAll(() => loaded.close());

  it("tab links", async () => {
    const page = (await loaded.inject("/")).body;
    expect(page).toContain('href="/?view=analysis"');
    expect(page).toContain(">API analysis<");
  });

  it("empty analysis tab", async () => {
    const app = await makeApp();
    expect((await app.inject("/?view=analysis")).body).toContain("No API traffic yet");
    await app.close();
  });

  it("all applications overview", async () => {
    const page = (await loaded.inject("/?view=analysis")).body;
    for (const app of Object.keys(APPS)) expect(page).toContain(`href="/?view=analysis&amp;app=${app}"`);
    expect(page).toContain("Unhealthy");
    expect(page).toContain("Healthy");
    expect(page).toContain("Busiest API");
  });

  it("one application page", async () => {
    const page = (await loaded.inject("/?view=analysis&app=orders-service")).body;
    for (const text of ["API calls by hour of day", "Recommended optimisations", "APIs by number of calls", "Peak hour (UTC)",
      "Quietest hour (UTC)", "Availability", "GET /orders/{id}/invoice", "Speed up: very slow", "Show as table"]) {
      expect(page, text).toContain(text);
    }
    expect(page.split('class="bar-slot"').length - 1).toBe(24);
    expect(page.split('class="bar-label">Peak<').length - 1).toBe(1);
  });

  it("cache advice shown for a shared API", async () => {
    const page = (await loaded.inject("/?view=analysis&app=auth-gateway")).body;
    const row = page.split("GET /.well-known/jwks.json</code></td>")[1].split("</tr>")[0];
    expect(row).toContain("Yes");
    expect(row).toContain("Cache (60 s, shared)");
  });

  it("unknown app on the analysis tab", async () => {
    expect((await loaded.inject("/?view=analysis&app=nope")).body).toContain("No API traffic recorded for");
  });

  it("the app selection is kept when switching tabs", async () => {
    expect((await loaded.inject("/?view=analysis&app=checkout-api")).body).toContain('href="/?app=checkout-api"');
  });

  it("escapes API paths", async () => {
    const app = await makeApp();
    await postCalls(app, { calls: [apiCall({ app: "x", path: "/<script>alert(1)</script>" })] });
    const page = (await app.inject("/?view=analysis&app=x")).body;
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;");
    await app.close();
  });
});
