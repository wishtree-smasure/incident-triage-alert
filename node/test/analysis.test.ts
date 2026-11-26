/** API analysis rules: grouping, percentiles, health, cacheability, advice, peaks. */

import { describe, expect, it } from "vitest";
import { analyzeApp, apiName, cacheability, health, overviewOfApps, percentile, summarize } from "../src/analysis.js";
import { ApiCallSchema, Investigation, type ApiCall } from "../src/models.js";

const T0 = Date.UTC(2026, 10, 23, 0, 0);
function call({ path = "/products", method = "GET", status = 200, ms = 50, hour = 12, app = "shop", minute = 0 } = {}): ApiCall {
  return ApiCallSchema.parse({ app, method, path, status, duration_ms: ms, time: new Date(T0 + hour * 3600_000 + minute * 60_000) });
}
const times = (n: number, c: ApiCall) => Array.from({ length: n }, () => c);
const alertFor = (app: string, severity: string | null, status = "queued") => new Investigation({
  id: `i-${app}-${severity}`, source_id: "s", service: app, status: status as any,
  alert: { source_id: "s", source_type: "generic", service: app, title: "t", severity_hint: severity as any, fired_at: new Date(T0) },
});

describe("grouping", () => {
  for (const [path, expected] of [
    ["/products", "/products"], ["/products/123", "/products/{id}"], ["/orders/42/invoice", "/orders/{id}/invoice"],
    ["/users/3fa85f64-5717-4562-b3fc-2c963f66afa6", "/users/{id}"], ["/products?page=2", "/products"],
    ["/products/", "/products"], ["/", "/"], ["/v2/products", "/v2/products"], // short words with digits are not ids
  ]) it(`${path} -> ${expected}`, () => expect(apiName(path)).toBe(expected));
});

describe("numbers", () => {
  it("percentile", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([percentile(values, 0.5), percentile(values, 0.95), percentile(values, 0.99)]).toEqual([50, 95, 99]);
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([7], 0.95)).toBe(7);
  });
  it("summarize counts errors and the peak", () => {
    const calls = [...times(3, call({ hour: 9 })), call({ hour: 14, status: 500 }), call({ hour: 14, status: 404 }), call({ hour: 14 })];
    const s = summarize(calls);
    expect(s.calls).toBe(6);
    expect(s.error_rate).toBeCloseTo(1 / 6);
    expect(s.client_error_rate).toBeCloseTo(1 / 6);
    expect([9, 14]).toContain(s.peak_hour);
    expect(s.peak_count).toBe(3);
  });
});

describe("health", () => {
  for (const [server, p95, client, stoppers, expected] of [
    [0, 100, 0, 0, "healthy"], [0.01, 100, 0, 0, "degraded"], [0, 800, 0, 0, "degraded"], [0, 100, 0.1, 0, "degraded"],
    [0.05, 100, 0, 0, "unhealthy"], [0, 2000, 0, 0, "unhealthy"], [0, 100, 0, 1, "unhealthy"],
  ] as const) it(`${server} ${p95} ${client} ${stoppers} -> ${expected}`, () => expect(health(server, p95, client, stoppers)).toBe(expected));
});

describe("cacheability", () => {
  for (const [method, path, expected] of [
    ["GET", "/products", "yes"], ["GET", "/products/{id}", "yes"], ["GET", "/.well-known/jwks.json", "yes"],
    ["GET", "/payment-methods", "yes"], ["GET", "/cart", "per-user"], ["GET", "/orders/{id}", "per-user"],
    ["GET", "/userinfo", "per-user"], ["GET", "/checkout/{id}/status", "no"], ["GET", "/health", "no"],
    ["POST", "/products", "no"], ["DELETE", "/cart/items/{id}", "no"],
  ]) it(`${method} ${path} -> ${expected}`, () => {
    const [label, reason] = cacheability(method, path);
    expect(label).toBe(expected);
    expect(reason).toBeTruthy();
  });
});

describe("one application", () => {
  it("a hot shared GET is recommended for caching", () => {
    const result = analyzeApp("shop", [...times(80, call({ path: "/products" })), ...times(20, call({ path: "/cart", method: "POST" }))], []);
    const products = result.apis.find((a) => a.path === "/products")!;
    expect(products.cache).toBe("yes");
    expect(products.share).toBeCloseTo(0.8);
    expect(products.actions).toEqual(["Cache (60 s, shared)"]);
    expect(products.advice[0]).toContain("Cache it: 80%");
  });

  it("a rare API is not worth caching", () => {
    const result = analyzeApp("shop", [...times(99, call({ path: "/cart", method: "POST" })), call({ path: "/categories" })], []);
    const categories = result.apis.find((a) => a.path === "/categories")!;
    expect(categories.cache).toBe("yes");
    expect(categories.advice).toEqual([]);
  });

  it("a slow write gets background-job advice", () => {
    const api = analyzeApp("shop", times(10, call({ path: "/reports", method: "POST", ms: 3000 })), []).apis[0];
    expect(api.health).toBe("unhealthy");
    expect(api.actions).toEqual(["Move to background job"]);
  });

  it("the most urgent recommendations come first", () => {
    const calls = [...times(50, call({ path: "/products" })), ...times(30, call({ path: "/orders", ms: 900 })),
      ...times(2, call({ path: "/checkout", method: "POST", status: 500 })), ...times(18, call({ path: "/checkout", method: "POST" }))];
    const texts = analyzeApp("shop", calls, []).recommendations.map((r) => r.text);
    expect(texts[0]).toContain("server errors");
    const firstCache = texts.findIndex((t) => t.startsWith("Cache"));
    expect(texts.slice(firstCache).every((t) => t.startsWith("Cache"))).toBe(true); // caching tips come last
    expect(texts.slice(0, firstCache).some((t) => t.includes("Slow (p95"))).toBe(true);
  });

  it("hourly traffic, peak and quiet hours", () => {
    const result = analyzeApp("shop", [...times(10, call({ hour: 13 })), ...times(6, call({ hour: 20 })), call({ hour: 4 })], []);
    expect(result.hourly).toHaveLength(24);
    expect(result.hourly[13]).toEqual({ hour: 13, calls: 10, height: 100 });
    expect(result.hourly[20].height).toBe(60);
    expect(result.overview.peak_hour).toBe(13);
    expect(result.quiet_hour).toBe(4);
  });

  it("a traffic spike recommends scaling", () => {
    const calls = [...Array.from({ length: 24 }, (_, h) => call({ hour: h })), ...times(30, call({ hour: 13 }))];
    const recs = analyzeApp("shop", calls, []).recommendations;
    expect(recs[0].api).toBe("Whole application");
    expect(recs[0].text).toContain("13:00 UTC");
  });

  it("calls per minute and availability", () => {
    const calls = Array.from({ length: 60 }, (_, m) => call({ minute: m })); // 60 calls over 59 minutes
    calls[0] = call({ minute: 0, status: 503 });
    const result = analyzeApp("shop", calls, []);
    expect(result.calls_per_min).toBeCloseTo(60 / 59);
    expect(result.availability).toBeCloseTo(59 / 60);
    expect(result.status_groups).toEqual({ "2xx": 59, "3xx": 0, "4xx": 0, "5xx": 1 });
  });

  it("an open show stopper makes the app unhealthy", () => {
    const alerts = [alertFor("shop", "SEV1"), alertFor("shop", "SEV3"),
      alertFor("shop", "SEV1", "concluded"), // closed: does not count
      alertFor("other", "SEV1")]; // another app: does not count
    const result = analyzeApp("shop", times(10, call()), alerts);
    expect(result.overview.health).toBe("unhealthy");
    expect([result.open_alerts, result.show_stoppers]).toEqual([2, 1]);
  });

  it("highlights", () => {
    const result = analyzeApp("shop", [...times(5, call({ path: "/a", ms: 10 })), call({ path: "/b", ms: 900, status: 500 }), ...times(2, call({ path: "/b", ms: 900 }))], []);
    expect(result.apis[0].path).toBe("/a"); // busiest first
    expect(result.slowest!.path).toBe("/b");
    expect(result.most_errors!.path).toBe("/b");
  });

  it("no errors means no most-errors highlight", () => expect(analyzeApp("shop", times(3, call()), []).most_errors).toBeNull());

  it("an empty application does not crash", () => {
    const result = analyzeApp("shop", [], []);
    expect(result.overview.calls).toBe(0);
    expect(result.apis).toEqual([]);
  });
});

it("overview puts the least healthy first", () => {
  const byApp = new Map([
    ["fast", times(10, call({ app: "fast" }))],
    ["slow", times(10, call({ app: "slow", ms: 3000 }))],
    ["meh", times(10, call({ app: "meh", ms: 900 }))],
  ]);
  const rows = overviewOfApps(byApp, []);
  expect(rows.map((r) => r.app)).toEqual(["slow", "meh", "fast"]);
  expect(rows[0].top_api).toBe("GET /products");
});

it("timing: analysis of 200,000 calls stays well under a second", () => {
  const calls = Array.from({ length: 200_000 }, (_, i) => call({ path: `/p${i % 40}/${i}`, hour: i % 24, ms: (i % 997) + 1, status: i % 50 ? 200 : 500 }));
  const started = performance.now();
  analyzeApp("shop", calls, []);
  expect(performance.now() - started).toBeLessThan(1500);
});
