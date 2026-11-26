/**
 * Realistic API traffic for the last 24 hours, for the API analysis tab.
 *
 * Each application has a few APIs, each with its own share of traffic, typical response time
 * and error rate. Traffic follows a daily curve (quiet at night, busy at lunch and in the
 * evening), and some APIs have built-in problems so the analysis tab has something to find.
 * Same seed = same traffic (a seeded generator, not Math.random).
 */

/** [method, path, share of the app's traffic, typical ms, server-error rate, client-error rate, own peak hour?] */
type Api = [string, string, number, number, number, number, number?];

// "{id}" is replaced by a random number, like real URLs. Without an own peak hour, an API
// follows the usual day: busy at lunch and in the evening.
export const APPS: Record<string, { calls_per_day: number; apis: Api[] }> = {
    "sample-shop": {
        "calls_per_day": 20000,
        "apis": [
            ["GET", "/products", 0.30, 60, 0.001, 0.0],        // hot, same for everyone: cache it
            ["GET", "/products/{id}", 0.25, 45, 0.001, 0.02],
            ["GET", "/categories", 0.08, 30, 0.0, 0.0],
            ["GET", "/cart", 0.10, 80, 0.002, 0.0],
            ["POST", "/cart/items", 0.08, 120, 0.003, 0.03],
            ["POST", "/checkout", 0.04, 900, 0.08, 0.01],        // the shop's bugs: slow and failing
            ["GET", "/orders/{id}", 0.05, 150, 0.004, 0.02],
            ["GET", "/health", 0.10, 5, 0.0, 0.0],
        ],
    },
    "checkout-api": {
        "calls_per_day": 15000,
        "apis": [
            ["GET", "/checkout/{id}/status", 0.30, 40, 0.002, 0.0],
            ["GET", "/payment-methods", 0.25, 90, 0.0, 0.0],     // shared list: cache it
            ["POST", "/checkout", 0.20, 450, 0.04, 0.02],         // 5xx after the bad deploy
            ["POST", "/payments/authorize", 0.15, 700, 0.03, 0.01],
            ["GET", "/health", 0.10, 5, 0.0, 0.0],
        ],
    },
    "orders-service": {
        "calls_per_day": 12000,
        "apis": [
            ["GET", "/orders", 0.30, 1400, 0.02, 0.0],            // slow list: DB pool pressure
            ["GET", "/orders/{id}", 0.30, 300, 0.01, 0.03],
            ["POST", "/orders", 0.15, 600, 0.02, 0.02],
            ["GET", "/orders/{id}/invoice", 0.10, 2400, 0.01, 0.0, 2],  // very slow, nightly batch at 02:00
            ["GET", "/health", 0.15, 5, 0.0, 0.0],
        ],
    },
    "auth-gateway": {
        "calls_per_day": 30000,
        "apis": [
            ["POST", "/oauth/token", 0.40, 120, 0.002, 0.12, 9],  // 401/403 spike; logins peak at 09:00
            ["GET", "/.well-known/jwks.json", 0.20, 15, 0.0, 0.0],  // public keys: cache it
            ["GET", "/userinfo", 0.25, 60, 0.001, 0.05],
            ["POST", "/logout", 0.05, 40, 0.0, 0.0],
            ["GET", "/health", 0.10, 5, 0.0, 0.0],
        ],
    },
    "billing-service": {
        "calls_per_day": 6000,
        "apis": [
            ["GET", "/invoices/{id}", 0.35, 180, 0.003, 0.02],
            ["POST", "/invoices", 0.15, 400, 0.01, 0.02],
            ["POST", "/reconciliation/run", 0.05, 4200, 0.06, 0.0, 3],  // nightly job at 03:00 that crashes
            ["GET", "/plans", 0.30, 35, 0.0, 0.0],                 // same for everyone: cache it
            ["GET", "/health", 0.15, 5, 0.0, 0.0],
        ],
    },
    "notification-service": {
        "calls_per_day": 9000,
        "apis": [
            ["POST", "/emails", 0.45, 650, 0.015, 0.01],           // queue backlog: slow at peak
            ["POST", "/sms", 0.15, 300, 0.005, 0.02],
            ["GET", "/templates/{id}", 0.25, 25, 0.0, 0.01],
            ["GET", "/health", 0.15, 5, 0.0, 0.0],
        ],
    },
    "reporting-service": {
        "calls_per_day": 2_500,
        "apis": [
            ["GET", "/reports/{id}", 0.40, 1200, 0.004, 0.02],     // heavy queries
            ["POST", "/reports/export", 0.15, 3500, 0.01, 0.01, 6],  // export batch at 06:00
            ["GET", "/dashboards", 0.30, 220, 0.0, 0.0],
            ["GET", "/health", 0.15, 5, 0.0, 0.0],
        ],
    },
}

export interface GeneratedCall {
  app: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  time: string;
}

/** Small seeded random number generator (mulberry32) with the helpers Python's random module has. */
export class Random {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  random(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }
  randint(a: number, b: number): number {
    return a + Math.floor(this.random() * (b - a + 1));
  }
  choice<T>(items: T[]): T {
    return items[Math.floor(this.random() * items.length)];
  }
  /** Normal distribution (Box-Muller), then e^x: Python's lognormvariate(mu, sigma). */
  lognormvariate(mu: number, sigma: number): number {
    const u = 1 - this.random();
    const v = this.random();
    return Math.exp(mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
  }
}

/** Distance on a 24-hour clock: 23:00 and 01:00 are 2 hours apart. */
export function hoursApart(a: number, b: number): number {
  return Math.min(Math.abs(a - b), 24 - Math.abs(a - b));
}

/**
 * Daily curve (UTC). Default: quiet at night, a lunch peak around 13:00 and an evening peak
 * around 20:00. With peakHour: one peak at that hour.
 */
export function busyness(hour: number, peakHour?: number): number {
  if (peakHour !== undefined) return 0.15 + Math.exp(-((hoursApart(hour, peakHour) / 2.5) ** 2));
  const lunch = Math.exp(-((hoursApart(hour, 13) / 2.5) ** 2));
  const evening = 0.8 * Math.exp(-((hoursApart(hour, 20) / 2.0) ** 2));
  return 0.15 + lunch + evening;
}

/** API-call records for every app, spread over the last `hours` hours. */
export function generate(now: Date, hours = 24, scale = 1.0, seed = 7): GeneratedCall[] {
  const rng = new Random(seed);
  const start = now.getTime() - hours * 3600_000;
  const hourStarts = Array.from({ length: hours }, (_, h) => new Date(start + h * 3600_000));
  const calls: GeneratedCall[] = [];

  for (const [app, profile] of Object.entries(APPS)) {
    const appCalls = (profile.calls_per_day * scale * hours) / 24;
    for (const [method, path, share, typicalMs, serverErr, clientErr, peak] of profile.apis) {
      const curve = hourStarts.map((hs) => busyness(hs.getUTCHours(), peak));
      const curveMax = Math.max(...curve);
      const curveSum = curve.reduce((a, b) => a + b, 0);
      hourStarts.forEach((hourStart, i) => {
        const weight = curve[i];
        const load = weight / curveMax; // 0..1, busier hours are slower and fail more
        const n = Math.round((appCalls * share * weight) / curveSum);
        for (let k = 0; k < n; k++) {
          const roll = rng.random();
          let status = 200;
          if (roll < serverErr * (0.5 + load)) status = rng.choice([500, 502, 503]);
          else if (roll < serverErr * (0.5 + load) + clientErr) status = rng.choice([400, 401, 403, 404]);
          const duration = rng.lognormvariate(Math.log(typicalMs), 0.45) * (1 + 0.6 * load);
          calls.push({
            app,
            method,
            path: path.replace("{id}", String(rng.randint(1, 99_999))),
            status,
            duration_ms: Math.round(duration * 10) / 10,
            time: new Date(hourStart.getTime() + rng.uniform(0, 3600) * 1000).toISOString(),
          });
        }
      });
    }
  }
  return calls.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}
