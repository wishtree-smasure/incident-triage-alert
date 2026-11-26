/**
 * API analysis: turns raw API calls into health, traffic and optimisation advice per application.
 *
 * Simple rules, all thresholds in one place:
 *   health      healthy / degraded / unhealthy, from server errors, client errors, p95 response
 *               time, and (for a whole application) open show-stopper alerts
 *   cacheable   yes / per-user / no, from the HTTP method and the path
 *   advice      cache hot read-only APIs, speed up slow ones, fix failing ones, scale before peaks
 */

import type { ApiCall, Investigation } from "./models.js";
import { comma, fixed, pad2, percent, roundHalfEven } from "./pyformat.js";

// ---- thresholds
export const SLOW_MS = 800; // p95 above this: degraded
export const VERY_SLOW_MS = 2000; // p95 above this: unhealthy
export const ERROR_WARN = 0.01; // 1% server errors: degraded
export const ERROR_BAD = 0.05; // 5% server errors: unhealthy
export const CLIENT_ERROR_WARN = 0.1; // 10% 4xx: worth a look
export const HOT_SHARE = 0.05; // an API with 5%+ of all calls is "hot"
export const SPIKE_RATIO = 2.5; // busiest hour this many times the average hour: plan for peaks

// Path words that mean the answer is different for each user, so a shared cache is unsafe.
const PERSONAL_WORDS = new Set(["cart", "me", "user", "userinfo", "session", "token", "login", "logout",
  "auth", "oauth", "checkout", "payments", "orders", "account"]);

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{16,})$/i;

export type Health = "healthy" | "degraded" | "unhealthy";
export type Cache = "yes" | "per-user" | "no";

export interface Summary {
  calls: number;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  error_rate: number;
  client_error_rate: number;
  peak_hour: number | null;
  peak_count: number;
  health: Health;
}

export interface ApiRow extends Summary {
  method: string;
  path: string;
  share: number;
  cache: Cache;
  cache_reason: string;
  advice: string[];
  actions: string[];
}

const trimSlashes = (s: string) => s.replace(/^\/+|\/+$/g, "");

/** '/orders/1234/invoice?x=1' -> '/orders/{id}/invoice', so calls to the same API group together. */
export function apiName(path: string): string {
  const parts = trimSlashes(path.split("?", 1)[0]).split("/").map((p) => (ID_SEGMENT.test(p) ? "{id}" : p));
  return "/" + parts.filter(Boolean).join("/");
}

export function percentile(sortedValues: number[], p: number): number {
  if (!sortedValues.length) return 0;
  return sortedValues[Math.max(0, Math.ceil(p * sortedValues.length) - 1)];
}

export function health(serverErrorRate: number, p95Ms: number, clientErrorRate = 0, openShowStoppers = 0): Health {
  if (openShowStoppers || serverErrorRate >= ERROR_BAD || p95Ms >= VERY_SLOW_MS) return "unhealthy";
  if (serverErrorRate >= ERROR_WARN || p95Ms >= SLOW_MS || clientErrorRate >= CLIENT_ERROR_WARN) return "degraded";
  return "healthy";
}

/** [open alerts, open show stoppers] for one application. */
export function openAlerts(alerts: Investigation[], app: string): [number, number] {
  const stillOpen = alerts.filter((i) => i.service === app && i.isOpen);
  return [stillOpen.length, stillOpen.filter((i) => i.severity === "SEV1").length];
}

/** Returns [yes | per-user | no, reason]. */
export function cacheability(method: string, path: string): [Cache, string] {
  const words = new Set(
    trimSlashes(path.toLowerCase()).split("/").flatMap((part) => part.split(/[^a-z]+/)).filter(Boolean),
  );
  if (method !== "GET" && method !== "HEAD") return ["no", `${method} changes data, so it must always run.`];
  if (words.has("health") || words.has("status")) return ["no", "Reports live state; caching would hide problems."];
  if ([...words].some((w) => PERSONAL_WORDS.has(w))) {
    return ["per-user", "The answer depends on the user: only cache per user / session, with a short TTL."];
  }
  return ["yes", "Read-only and the same for everyone: safe to cache (CDN or Redis)."];
}

/** Counts in first-seen order, like Python's Counter. */
function counter<K>(items: Iterable<K>): Map<K, number> {
  const counts = new Map<K, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

/** Counter.most_common(1): the highest count; on a tie, the first seen. */
function mostCommon<K>(counts: Map<K, number>): [K, number] | null {
  let best: [K, number] | null = null;
  for (const [k, n] of counts) if (!best || n > best[1]) best = [k, n];
  return best;
}

/** Python's max(items, key=...): the first item with the highest key. */
function maxBy<T>(items: T[], key: (t: T) => number): T | null {
  let best: T | null = null;
  for (const item of items) if (best === null || key(item) > key(best)) best = item;
  return best;
}

/** Numbers shared by an application and by a single API. */
export function summarize(calls: ApiCall[]): Summary {
  const n = calls.length;
  const durations = calls.map((c) => c.duration_ms).sort((a, b) => a - b);
  const serverErrors = calls.filter((c) => c.status >= 500).length;
  const clientErrors = calls.filter((c) => c.status >= 400 && c.status < 500).length;
  const peak = mostCommon(counter(calls.map((c) => c.time.getUTCHours())));
  const p95 = percentile(durations, 0.95);
  const errorRate = n ? serverErrors / n : 0;
  const clientErrorRate = n ? clientErrors / n : 0;
  let total = 0;
  for (const d of durations) total += d;
  return {
    calls: n,
    avg_ms: n ? total / n : 0,
    p50_ms: percentile(durations, 0.5),
    p95_ms: p95,
    p99_ms: percentile(durations, 0.99),
    max_ms: n ? durations[n - 1] : 0,
    error_rate: errorRate,
    client_error_rate: clientErrorRate,
    peak_hour: peak ? peak[0] : null,
    peak_count: peak ? peak[1] : 0,
    health: health(errorRate, p95, clientErrorRate),
  };
}

type Advice = [priority: number, label: string, text: string];

/**
 * Optimisation suggestions for one API. Lower number = do it first:
 * 0 failing, 1 very slow, 2 slow, 3 many client errors, 4 caching.
 */
export function apiAdvice(api: Omit<ApiRow, "advice" | "actions">): Advice[] {
  const advice: Advice[] = [];
  if (api.error_rate >= ERROR_WARN) {
    advice.push([0, "Fix server errors", `${percent(api.error_rate, 1)} server errors: check the Alerts tab for this application and fix the top error.`]);
  }
  if (api.p95_ms >= VERY_SLOW_MS) {
    if (api.method === "GET") {
      advice.push([1, "Speed up: very slow", `Very slow (p95 ${comma(api.p95_ms)} ms): add a database index, paginate, or precompute the result.`]);
    } else {
      advice.push([1, "Move to background job", `Very slow (p95 ${comma(api.p95_ms)} ms): move the slow work to a background job and return 202 straight away.`]);
    }
  } else if (api.p95_ms >= SLOW_MS) {
    advice.push([2, "Speed up: slow", `Slow (p95 ${comma(api.p95_ms)} ms): find the slowest query or external call and add a timeout.`]);
  }
  if (api.client_error_rate >= CLIENT_ERROR_WARN) {
    advice.push([3, "Check auth / validation", `${percent(api.client_error_rate, 0)} client errors (4xx): callers send bad or unauthorized requests. Check auth and input validation.`]);
  }
  if (api.cache === "yes" && api.share >= HOT_SHARE) {
    advice.push([4, "Cache (60 s, shared)", `Cache it: ${percent(api.share, 0)} of all calls, read-only and shared. A 60 s cache would serve most of them without touching the backend.`]);
  } else if (api.cache === "per-user" && api.method === "GET" && api.share >= HOT_SHARE) {
    advice.push([4, "Cache per user (30 s)", "Cache per user for a short time (e.g. 30 s) to cut repeated calls."]);
  }
  return advice;
}

/** Python's tuple ordering for (priority, -calls, api, text). */
function compareTuples(a: (number | string)[], b: (number | string)[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

/** Everything the analysis tab shows for one application. */
export function analyzeApp(app: string, calls: ApiCall[], alerts: Investigation[]) {
  const overview = summarize(calls);
  const [nOpen, nStoppers] = openAlerts(alerts, app);
  if (nStoppers) overview.health = "unhealthy";
  const total = overview.calls;

  // Traffic per hour of the day (UTC)
  const perHour = counter(calls.map((c) => c.time.getUTCHours()));
  const busiest = Math.max(0, ...perHour.values());
  const hourly = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    calls: perHour.get(h) ?? 0,
    height: busiest ? roundHalfEven((100 * (perHour.get(h) ?? 0)) / busiest) : 0,
  }));
  const active = hourly.filter((h) => h.calls);
  let quiet: (typeof hourly)[number] | null = null;
  for (const h of active) if (!quiet || h.calls < quiet.calls) quiet = h;
  const avgPerHour = active.length ? total / active.length : 0;

  // Calls per minute, over the time the data covers
  let spanMin = 1;
  if (calls.length) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of calls) {
      const t = c.time.getTime();
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    spanMin = Math.max(1, (hi - lo) / 60000);
  }

  const statusGroups = counter(calls.map((c) => `${Math.floor(c.status / 100)}xx`));

  // Per API
  const grouped = new Map<string, { method: string; path: string; calls: ApiCall[] }>();
  for (const c of calls) {
    const path = apiName(c.path);
    const key = `${c.method} ${path}`;
    if (!grouped.has(key)) grouped.set(key, { method: c.method, path, calls: [] });
    grouped.get(key)!.calls.push(c);
  }
  const apis: (ApiRow & { _advice: Advice[] })[] = [];
  for (const { method, path, calls: apiCalls } of grouped.values()) {
    const [cache, cacheReason] = cacheability(method, path);
    const base = { method, path, ...summarize(apiCalls), share: apiCalls.length / total, cache, cache_reason: cacheReason };
    const advice = apiAdvice(base);
    apis.push({ ...base, advice: advice.map((a) => a[2]), actions: advice.map((a) => a[1]), _advice: advice });
  }
  apis.sort((a, b) => b.calls - a.calls);

  // Recommendations for the whole application: most urgent kind first, then the busiest API
  const ranked = apis
    .flatMap((a) => a._advice.map(([priority, , text]) => [priority, -a.calls, `${a.method} ${a.path}`, text] as const))
    .sort((x, y) => compareTuples([...x], [...y]));
  const recommendations = ranked.map(([, , api, text]) => ({ api, text }));
  const cleanApis: ApiRow[] = apis.map(({ _advice, ...rest }) => rest);
  const spike = avgPerHour ? busiest / avgPerHour : 0;
  if (spike >= SPIKE_RATIO) {
    recommendations.unshift({
      api: "Whole application",
      text: `Traffic at ${pad2(overview.peak_hour ?? 0)}:00 UTC is ${fixed(spike, 1)}x the average hour. ` +
        "Scale out before the peak (or enable autoscaling) and avoid deploys at that time.",
    });
  }

  return {
    overview,
    calls_per_min: total / spanMin,
    availability: 1 - overview.error_rate,
    hourly,
    busiest,
    quiet_hour: quiet ? quiet.hour : null,
    spike,
    status_groups: Object.fromEntries(["2xx", "3xx", "4xx", "5xx"].map((k) => [k, statusGroups.get(k) ?? 0])) as Record<string, number>,
    apis: cleanApis,
    slowest: maxBy(cleanApis, (a) => a.p95_ms),
    most_errors: maxBy(cleanApis.filter((a) => a.error_rate > 0), (a) => a.error_rate),
    recommendations: recommendations.slice(0, 8),
    open_alerts: nOpen,
    show_stoppers: nStoppers,
  };
}
export type AppAnalysis = ReturnType<typeof analyzeApp>;

/** One row per application for the 'All applications' view, least healthy first. */
export function overviewOfApps(callsByApp: Map<string, ApiCall[]>, alerts: Investigation[]) {
  const rank: Record<Health, number> = { unhealthy: 0, degraded: 1, healthy: 2 };
  const rows = [];
  for (const [app, calls] of callsByApp) {
    const summary = summarize(calls);
    const top = mostCommon(counter(calls.map((c) => `${c.method} ${apiName(c.path)}`)));
    const [nOpen, nStoppers] = openAlerts(alerts, app);
    if (nStoppers) summary.health = "unhealthy";
    rows.push({ app, ...summary, top_api: top ? top[0] : "", open_alerts: nOpen, show_stoppers: nStoppers });
  }
  rows.sort((a, b) => rank[a.health] - rank[b.health] || b.calls - a.calls);
  return rows;
}
