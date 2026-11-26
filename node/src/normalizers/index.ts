/** Turn a vendor payload into a NormalizedAlert, picking the normalizer by source type. */

import { NormalizedAlertSchema, type NormalizedAlert } from "../models.js";
import type { Source } from "../registry.js";

export class NormalizationError extends Error {
  name = "NormalizationError";
}

type Payload = Record<string, any>;

function need<T = any>(obj: Payload, key: string): T {
  if (obj === null || typeof obj !== "object" || !(key in obj)) throw new Error(`missing ${JSON.stringify(key)}`);
  return obj[key];
}

function alert(source: Source, fields: Record<string, unknown>, raw: Payload): NormalizedAlert {
  return NormalizedAlertSchema.parse({ source_id: source.id, source_type: source.type, service: source.service, raw, ...fields });
}

/** Azure Monitor common alert schema: the fields we need live in data.essentials. Sev0 is the most severe. */
const AZURE_SEVERITY: Record<string, string> = { Sev0: "SEV1", Sev1: "SEV2", Sev2: "SEV3", Sev3: "SEV4", Sev4: "SEV4" };
function azureMonitor(payload: Payload, source: Source): NormalizedAlert {
  const e = need(need(payload, "data"), "essentials");
  const targets: unknown[] = e.alertTargetIDs?.length ? e.alertTargetIDs : [null];
  return alert(source, {
    title: need(e, "alertRule"),
    description: e.description ?? "",
    severity_hint: AZURE_SEVERITY[e.severity] ?? null,
    fired_at: need(e, "firedDateTime"),
    resource: targets[0] ?? null,
    labels: { monitor_condition: e.monitorCondition ?? "", signal_type: e.signalType ?? "" },
  }, payload);
}

/** AWS CloudWatch alarm sent through SNS: the alarm is a JSON *string* in "Message". No severity. */
function cloudwatch(payload: Payload, source: Source): NormalizedAlert {
  const message = need(payload, "Message");
  if (typeof message !== "string") throw new TypeError("Message must be a JSON string");
  const alarm = JSON.parse(message);
  const trigger = alarm.Trigger ?? {};
  const dimensions: { name: string; value: string }[] = trigger.Dimensions ?? [];
  const resource = dimensions.map((d) => `${need(d, "name")}=${need(d, "value")}`).join(",") || alarm.AlarmArn || null;
  return alert(source, {
    title: need(alarm, "AlarmName"),
    description: alarm.NewStateReason ?? "",
    fired_at: need(alarm, "StateChangeTime"),
    resource,
    labels: { metric_name: trigger.MetricName ?? "", region: alarm.Region ?? "" },
  }, payload);
}

/**
 * Datadog monitor webhook with this template:
 *   {"title": "$EVENT_TITLE", "body": "$EVENT_MSG", "date": "$DATE", "priority": "$ALERT_PRIORITY",
 *    "tags": "$TAGS", "alert_scope": "$ALERT_SCOPE"}
 * $DATE is epoch milliseconds; $TAGS is "key:value,key:value".
 */
const DATADOG_SEVERITY: Record<string, string> = { P1: "SEV1", P2: "SEV2", P3: "SEV3", P4: "SEV4", P5: "SEV4" };
function datadog(payload: Payload, source: Source): NormalizedAlert {
  const tags: Record<string, string> = {};
  for (const tag of String(payload.tags ?? "").split(",")) {
    const i = tag.indexOf(":");
    if (i >= 0) tags[tag.slice(0, i)] = tag.slice(i + 1);
  }
  const date = String(need(payload, "date")).trim();
  if (!/^[+-]?\d+$/.test(date)) throw new Error(`invalid date ${JSON.stringify(date)}`);
  return alert(source, {
    title: need(payload, "title"),
    description: payload.body ?? "",
    severity_hint: DATADOG_SEVERITY[payload.priority] ?? null,
    fired_at: Number(date),
    resource: payload.alert_scope ?? null,
    labels: tags,
  }, payload);
}

/**
 * In-house app alert, our own format:
 *   {"title", "service", "description", "severity": "SEV1..SEV4", "fired_at": ISO-8601, "resource", "labels"}
 * "service" is optional, so one in-house source can report for several applications.
 */
function generic(payload: Payload, source: Source): NormalizedAlert {
  return alert(source, {
    service: payload.service || source.service,
    title: need(payload, "title"),
    description: payload.description ?? "",
    severity_hint: payload.severity ?? null,
    fired_at: need(payload, "fired_at"),
    resource: payload.resource ?? null,
    labels: payload.labels ?? {},
  }, payload);
}

const NORMALIZERS = { azure_monitor: azureMonitor, cloudwatch, datadog, generic };

export function normalize(source: Source, payload: unknown): NormalizedAlert {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new NormalizationError("payload must be a JSON object");
  }
  try {
    return NORMALIZERS[source.type](payload as Payload, source);
  } catch (e) {
    throw new NormalizationError(`bad ${source.type} payload: ${(e as Error).message}`);
  }
}
