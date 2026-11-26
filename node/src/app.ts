/** Fastify app: receives signed alerts and API-call logs, and serves the dashboard. */

import crypto from "node:crypto";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import nunjucks from "nunjucks";
import { analyzeApp, openAlerts, overviewOfApps, type AppAnalysis } from "./analysis.js";
import * as dashboard from "./dashboard.js";
import { openDatabase, type Database } from "./db.js";
import { DedupCache, fingerprint } from "./dedup.js";
import * as demo from "./demo.js";
import { codeLocation } from "./location.js";
import { ApiCallBatchSchema, Investigation, type ApiCall } from "./models.js";
import { normalize, NormalizationError } from "./normalizers/index.js";
import { loadPlaybook, suggest, type Rule } from "./playbook.js";
import { comma, fixed, pad2, percent } from "./pyformat.js";
import { loadRegistry, type Registry, type Source } from "./registry.js";
import { isValidSignature } from "./security.js";
import { loadDotenv, loadSettings, NODE_ROOT, PROJECT_ROOT, type Settings } from "./settings.js";
import { InvestigationStore, MAX_ITEMS } from "./store.js";
import { TrafficStore } from "./traffic.js";

export interface AppState {
  settings: Settings;
  registry: Registry;
  playbook: Rule[];
  db: Database | null;
  dedup: DedupCache;
  store: InvestigationStore;
  traffic: TrafficStore;
}

declare module "fastify" {
  interface FastifyInstance {
    state: AppState;
  }
}

class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

/** The body as text; bytes that are not valid UTF-8 make it unusable (422), as in the Python app. */
function jsonBody(body: Buffer): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}

const pad = (n: number) => String(n).padStart(2, "0");
const hms = (d: Date) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export function makeTemplates(): nunjucks.Environment {
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(NODE_ROOT, "views")), { autoescape: true });
  env.addFilter("iso", (d: Date) => d.toISOString());
  env.addFilter("hms", (d: Date) => hms(d));
  env.addFilter("ymdhms", (d: Date) => `${ymd(d)} ${hms(d)}`);
  env.addFilter("comma", (n: number, digits = 0) => comma(n, digits));
  env.addFilter("fixed", (n: number, digits = 1) => fixed(n, digits));
  env.addFilter("percent", (n: number, digits = 1) => percent(n, digits));
  env.addFilter("pad2", (n: number) => pad2(n));
  env.addGlobal("code_location", codeLocation);
  return env;
}

/** Placeholder: the AI investigation agent is added after the port. */
function runInvestigation(_investigationId: string): void {}

export interface CreateAppOptions {
  settings?: Settings;
  registry?: Registry;
  logger?: boolean;
}

export async function createApp(opts: CreateAppOptions = {}): Promise<FastifyInstance> {
  loadDotenv(); // makes SRC_*_SECRET available to the registry
  const settings = opts.settings ?? loadSettings();
  const registry = opts.registry ?? loadRegistry(settings.sources_path);
  const playbook = loadPlaybook(settings.playbook_path);
  const db = await openDatabase(settings.database_url, PROJECT_ROOT);
  const state: AppState = {
    settings,
    registry,
    playbook,
    db,
    dedup: await new DedupCache(settings.dedup_ttl_min, undefined, db).load(),
    store: await new InvestigationStore(db).load(),
    traffic: await new TrafficStore(undefined, db).load(),
  };

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 20 * 1024 * 1024 });
  app.decorate("state", state);
  const templates = makeTemplates();
  const render = (reply: FastifyReply, name: string, context: object, status = 200) =>
    reply.code(status).type("text/html; charset=utf-8").send(templates.render(name, context));

  // Keep the raw body: the signature is computed over the exact bytes that were sent.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.setErrorHandler((error: Error & { statusCode?: number }, _req, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) app.log.error(error);
    reply.code(status).send({ detail: status >= 500 ? "internal error" : error.message });
  });

  /** The checks every incoming request must pass: known source (404), correct signature (401). */
  function verifiedBody(req: FastifyRequest<{ Params: { sourceId: string } }>): [Source, Buffer] {
    const source = registry.get(req.params.sourceId);
    if (!source) throw new HttpError(404, "unknown source");
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const signature = req.headers["x-signature"];
    if (!isValidSignature(registry.secretFor(source.id), body, Array.isArray(signature) ? signature[0] : signature)) {
      throw new HttpError(401, "invalid or missing signature");
    }
    return [source, body];
  }

  app.get("/health", async () => ({ status: "ok" }));

  // The analysis over up to 200,000 calls is cached per traffic version and alert set:
  // Node runs requests on one thread, so recomputing on every page view would hold up incoming alerts.
  let analysisCache: { key: string; byApp: Map<string, ApiCall[]>; rows: ReturnType<typeof overviewOfApps>; apps: Map<string, AppAnalysis> } | null = null;
  function analysisFor(alerts: Investigation[]) {
    const key = `${state.traffic.version}|${alerts.map((a) => `${a.id}:${a.status}:${a.severity}`).join(",")}`;
    if (analysisCache?.key !== key) {
      const byApp = new Map<string, ApiCall[]>();
      for (const c of state.traffic.calls) {
        if (!byApp.has(c.app)) byApp.set(c.app, []);
        byApp.get(c.app)!.push(c);
      }
      const sorted = new Map([...byApp.keys()].sort().map((k) => [k, byApp.get(k)!]));
      analysisCache = { key, byApp: sorted, rows: overviewOfApps(sorted, alerts), apps: new Map() };
    }
    return analysisCache;
  }

  app.get<{ Querystring: Record<string, string | undefined> }>("/", async (req, reply) => {
    const qs = req.query;
    const filters: dashboard.Filters = {
      view: qs.view === "analysis" ? "analysis" : null,
      app: qs.app || null,
      source: qs.source || null,
      level: qs.level === "alert" || qs.level === "warning" ? qs.level : null,
      q: qs.q || null,
    };
    const alerts = state.store.newestFirst();
    const context: Record<string, unknown> = dashboard.build(alerts, registry, filters);
    const partial = ["1", "true", "yes", "on"].includes(String(qs.partial ?? "").toLowerCase());
    if (partial && filters.view === null) {
      // Just the live part of the Alerts view: the page script swaps it in without a reload.
      return render(reply, "_alerts.html", context);
    }
    if (filters.view === "analysis") {
      const cached = analysisFor(alerts);
      context.traffic_apps = [...cached.byApp.keys()];
      context.app_rows = cached.rows;
      // Applications with alerts but no API calls yet: listed too, so none look missing.
      context.quiet_apps = [...new Set(alerts.map((i) => i.service))]
        .filter((name) => !cached.byApp.has(name))
        .sort()
        .map((name) => {
          const [n, sev1] = openAlerts(alerts, name);
          return { app: name, open_alerts: n, show_stoppers: sev1 };
        });
      context.analysis = null;
      if (filters.app && cached.byApp.has(filters.app)) {
        if (!cached.apps.has(filters.app)) cached.apps.set(filters.app, analyzeApp(filters.app, cached.byApp.get(filters.app)!, alerts));
        context.analysis = cached.apps.get(filters.app);
      }
    }
    // The Alerts view updates itself with a script; the analysis view refreshes every 30 s.
    return render(reply, "index.html", { ...context, refresh: filters.view === "analysis" ? 30 : null });
  });

  app.get<{ Params: { id: string } }>("/investigations/:id", async (req, reply) => {
    const inv = state.store.get(req.params.id);
    if (!inv) {
      // A friendly page, not raw JSON: usually an old link from before a restart.
      return render(reply, "not_found.html", { investigation_id: req.params.id, kept: MAX_ITEMS, saved: db !== null }, 404);
    }
    return render(reply, "investigation.html", {
      inv,
      source_name: registry.nameOf(inv.source_id),
      refresh: inv.isOpen ? 5 : null,
    });
  });

  app.post<{ Params: { sourceId: string } }>("/hooks/:sourceId", async (req, reply) => {
    // 1-2. Known source and correct signature?
    const [source, body] = verifiedBody(req);

    // 3. Convert the vendor payload to our common shape.
    let alert;
    try {
      alert = normalize(source, jsonBody(body));
    } catch (e) {
      if (e instanceof SyntaxError || e instanceof TypeError || e instanceof NormalizationError) throw new HttpError(422, e.message);
      throw e;
    }

    // 4. Same alert still open (or seen in the last few minutes)? Count it on that investigation.
    const stateOf = (id: string) => {
      const inv = state.store.get(id);
      if (!inv) return null; // no longer kept: start a new one
      return inv.isOpen ? "open" : "closed";
    };
    const newId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const [invId, count, duplicate] = await state.dedup.check(fingerprint(alert), newId, stateOf);

    if (duplicate) {
      const existing = state.store.get(invId);
      if (existing) {
        existing.dedup_count = count;
        await state.store.save(existing);
      }
    } else {
      await state.store.add(new Investigation({
        id: invId,
        source_id: source.id,
        service: alert.service,
        alert,
        suggestion: suggest(alert, playbook),
      }));
      setImmediate(() => runInvestigation(invId));
    }

    // 5. Answer right away; the investigation runs in the background.
    return reply.code(202).send({ investigation_id: invId, deduplicated: duplicate, dedup_count: count });
  });

  app.post<{ Params: { sourceId: string } }>("/requests/:sourceId", async (req, reply) => {
    // A batch of API calls from an application's access log: {"calls": [...]}.
    const [, body] = verifiedBody(req);
    let parsed;
    try {
      parsed = ApiCallBatchSchema.safeParse(jsonBody(body));
    } catch {
      throw new HttpError(422, "bad API call batch: not JSON");
    }
    if (!parsed.success) throw new HttpError(422, `bad API call batch: ${parsed.error.issues.length} problem(s)`);
    await state.traffic.add(parsed.data.calls);
    return reply.code(202).send({ accepted: parsed.data.calls.length });
  });

  // Webhook URLs only take POST.
  for (const url of ["/hooks/:sourceId", "/requests/:sourceId"]) {
    app.get(url, async (_req, reply) => reply.code(405).header("allow", "POST").send({ detail: "Method Not Allowed" }));
  }

  let stopDemo: (() => void) | null = null;
  app.addHook("onClose", async () => {
    stopDemo?.();
    await db?.close();
  });
  if (settings.demo_mode) {
    app.addHook("onListen", async () => {
      stopDemo = demo.start(state, `http://127.0.0.1:${(app.server.address() as { port: number }).port}`);
    });
  }
  return app;
}
