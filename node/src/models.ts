/** Data shapes used across the app. Field names match the Python app, so saved data is shared. */

import { z } from "zod";

export const SEVERITIES = ["SEV1", "SEV2", "SEV3", "SEV4"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type Status = "queued" | "running" | "concluded" | "inconclusive" | "failed";

/** A date-time; one without a time zone is read as UTC. */
export function toUtcDate(value: string | number | Date): Date {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value === "number") return new Date(value);
  const s = value.trim();
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s);
  const isDateTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s);
  const d = new Date(isDateTime && !hasZone ? `${s.replace(" ", "T")}Z` : s);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid datetime: ${JSON.stringify(value)}`);
  return d;
}

const utcDate = z.union([z.string(), z.number(), z.date()]).transform((v, ctx) => {
  try {
    return toUtcDate(v);
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
    return z.NEVER;
  }
});

export const NormalizedAlertSchema = z.object({
  source_id: z.string(),
  source_type: z.string(),
  service: z.string(),
  title: z.string(),
  description: z.string().default(""),
  severity_hint: z.enum(SEVERITIES).nullable().default(null),
  fired_at: utcDate,
  resource: z.string().nullable().default(null),
  labels: z.record(z.string()).default({}),
  raw: z.record(z.unknown()).default({}),
});
export type NormalizedAlert = z.infer<typeof NormalizedAlertSchema>;

export const ToolCallSchema = z.object({
  id: z.string(),
  tool: z.string(),
  args: z.record(z.unknown()).default({}),
  result_summary: z.string().default(""),
  duration_ms: z.number().int().default(0),
  tokens: z.number().int().default(0),
});

export const VerdictSchema = z
  .object({
    investigation_id: z.string(),
    status: z.enum(["concluded", "inconclusive", "failed"]),
    severity: z.enum(SEVERITIES),
    category: z.enum(["deployment", "infrastructure", "database", "dependency", "security", "configuration", "unknown"]),
    summary: z.string(),
    root_cause: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
    evidence: z.array(z.object({ claim: z.string(), tool_call_id: z.string(), source_link: z.string().nullable().default(null) })).default([]),
    ruled_out: z.array(z.string()).default([]),
    blast_radius: z.object({ services: z.array(z.string()).default([]), user_impact: z.string().default("") }).default({}),
    next_checks: z.array(z.string()).default([]),
    duration_sec: z.number().default(0),
    tool_calls_used: z.number().int().default(0),
    tokens_used: z.number().int().default(0),
    est_cost_usd: z.number().default(0),
  })
  .refine((v) => v.status !== "concluded" || v.evidence.length > 0, "a concluded verdict needs at least one evidence item");
export type Verdict = z.infer<typeof VerdictSchema>;

export const ApiCallSchema = z.object({
  app: z.string(),
  method: z.string().transform((m) => m.toUpperCase()),
  path: z.string(),
  status: z.number().int().min(100).max(599),
  duration_ms: z.number().min(0),
  time: utcDate,
});
export type ApiCall = z.infer<typeof ApiCallSchema>;

export const ApiCallBatchSchema = z.object({ calls: z.array(ApiCallSchema).max(10_000) });

export interface Suggestion {
  cause: string;
  immediate: string; // stop the damage now
  fix: string; // proper fix afterwards
}

const SuggestionSchema = z.object({ cause: z.string(), immediate: z.string(), fix: z.string() });

export const InvestigationSchema = z.object({
  id: z.string(),
  source_id: z.string(),
  service: z.string(),
  alert: NormalizedAlertSchema,
  status: z.enum(["queued", "running", "concluded", "inconclusive", "failed"]).default("queued"),
  created_at: utcDate.default(() => new Date()),
  dedup_count: z.number().int().default(1),
  trace: z.array(ToolCallSchema).default([]),
  suggestion: SuggestionSchema.nullable().default(null),
  verdict: VerdictSchema.nullable().default(null),
});
type InvestigationData = z.input<typeof InvestigationSchema>;

/** What we keep for each alert we investigate. */
export class Investigation {
  id!: string;
  source_id!: string;
  service!: string;
  alert!: NormalizedAlert;
  status!: Status;
  created_at!: Date;
  dedup_count!: number;
  trace!: z.infer<typeof ToolCallSchema>[];
  suggestion!: Suggestion | null;
  verdict!: Verdict | null;

  constructor(data: InvestigationData) {
    Object.assign(this, InvestigationSchema.parse(data));
  }

  /** The agent's verdict severity once known, otherwise what the monitoring tool sent. */
  get severity(): Severity | null {
    return this.verdict ? this.verdict.severity : this.alert.severity_hint;
  }

  /** SEV3/SEV4 are warnings. Everything else, including unknown severity, is an alert. */
  get level(): "alert" | "warning" {
    return this.severity === "SEV3" || this.severity === "SEV4" ? "warning" : "alert";
  }

  get isOpen(): boolean {
    return this.status === "queued" || this.status === "running";
  }

  /** The same JSON the Python app saves (pydantic model_dump_json). */
  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      source_id: this.source_id,
      service: this.service,
      alert: this.alert,
      status: this.status,
      created_at: this.created_at,
      dedup_count: this.dedup_count,
      trace: this.trace,
      suggestion: this.suggestion,
      verdict: this.verdict,
    };
  }

  static fromJSON(json: string): Investigation {
    return new Investigation(JSON.parse(json));
  }
}
