/**
 * Builds what the dashboard shows: show stoppers, applications, sources and alerts grouped by
 * priority. Filters: ?view=analysis&app=<service>&source=<source_id>&level=alert|warning&q=<search>
 */

import type { Investigation, Severity } from "./models.js";
import type { Registry } from "./registry.js";

// Highest priority first. Unknown severity (e.g. CloudWatch) sits between alerts and warnings.
const PRIORITIES: [Severity | null, string][] = [
  ["SEV1", "SEV1 · Show stopper"],
  ["SEV2", "SEV2 · High"],
  [null, "Unrated · needs triage"],
  ["SEV3", "SEV3 · Medium"],
  ["SEV4", "SEV4 · Low"],
];
const RANK = new Map(PRIORITIES.map(([severity], rank) => [severity, rank]));

/** Sort: highest priority first, then newest first. */
export function byPriority(a: Investigation, b: Investigation): number {
  return RANK.get(a.severity)! - RANK.get(b.severity)! || b.created_at.getTime() - a.created_at.getTime();
}

export function count(investigations: Investigation[]) {
  return {
    total: investigations.length,
    stoppers: investigations.filter((i) => i.severity === "SEV1").length,
    alert: investigations.filter((i) => i.level === "alert").length,
    warning: investigations.filter((i) => i.level === "warning").length,
    duplicates: investigations.reduce((n, i) => n + i.dedup_count - 1, 0),
  };
}

/** Search: case-insensitive text match on title, application, where it broke and the description. */
export function matches(inv: Investigation, q: string): boolean {
  const a = inv.alert;
  const text = [a.title, inv.service, a.resource, a.description].filter(Boolean).join(" ");
  return text.toLowerCase().includes(q.toLowerCase());
}

export interface Filters {
  view: "analysis" | null;
  app: string | null;
  source: string | null;
  level: "alert" | "warning" | null;
  q: string | null;
}

export function build(everything: Investigation[], registry: Registry, filters: Filters) {
  const { view, app, source, level } = filters;
  // Show stoppers are always shown, whatever filter is selected.
  const showStoppers = everything.filter((i) => i.severity === "SEV1").sort(byPriority);

  // Applications: worst first.
  const applications = [...new Set(everything.map((i) => i.service))].map((name) => {
    const items = everything.filter((i) => i.service === name);
    return { name, counts: count(items), worst: Math.min(...items.map((i) => RANK.get(i.severity)!)) };
  });
  applications.sort((a, b) => a.worst - b.worst || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const inApp = everything.filter((i) => app === null || i.service === app);
  // Sources: every registered source, with how many alerts it has for the selected app.
  const sources = [...registry.sources.values()].map((s) => ({
    id: s.id,
    name: registry.nameOf(s.id),
    n: inApp.filter((i) => i.source_id === s.id).length,
  }));
  const inSource = inApp.filter((i) => source === null || i.source_id === source);
  const q = filters.q?.trim() || null;
  const matching = inSource.filter((i) => q === null || matches(i, q));
  const shown = matching.filter((i) => level === null || i.level === level);

  const groups = PRIORITIES.map(([severity, label]) => ({
    severity,
    label,
    items: shown.filter((i) => i.severity === severity).sort(byPriority),
  })).filter((g) => g.items.length);

  /** A dashboard URL with some filters changed; called from templates as link(app=none, ...). */
  function link(changes: Record<string, unknown> = {}): string {
    const params: Record<string, unknown> = { view, app, source, level, q };
    for (const [k, v] of Object.entries(changes)) if (k !== "__keywords") params[k] = v;
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) query.set(k, String(v));
    const s = query.toString();
    return s ? `/?${s}` : "/";
  }

  return {
    show_stoppers: showStoppers,
    applications,
    app_names: applications.map((a) => a.name),
    all_counts: count(everything),
    sources,
    counts: count(matching),
    shown: shown.length,
    groups,
    app,
    source,
    level,
    view,
    q,
    filtered: Boolean(app || source || level || q),
    link,
    source_name: (id: string) => registry.nameOf(id),
  };
}
