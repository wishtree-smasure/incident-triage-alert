/** The sample incidents and warnings in fixtures/sample_alerts.json, signed and sent to the app. */

import fs from "node:fs";
import path from "node:path";
import { postSigned, SOURCE_ID as TRAFFIC_SOURCE_ID } from "./logwatch.js";
import type { Registry } from "./registry.js";
import { PROJECT_ROOT } from "./settings.js";

export interface Sample {
  source_id: string;
  payload: Record<string, any>;
  repeat?: number;
  note: string;
}

export function loadSamples(file = path.join(PROJECT_ROOT, "fixtures", "sample_alerts.json")): Sample[] {
  const samples: Sample[] = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const s of samples) {
    // SNS sends the CloudWatch alarm as a JSON *string*; the file keeps it readable as an object.
    if (s.payload.Message && typeof s.payload.Message === "object") s.payload.Message = JSON.stringify(s.payload.Message);
  }
  return samples;
}

/** Sign and send every sample. Returns [HTTP status, note] for each request. */
export async function sendAll(baseUrl: string, registry: Registry): Promise<[number | string, string][]> {
  const results: [number | string, string][] = [];
  for (const sample of loadSamples()) {
    for (let i = 0; i < (sample.repeat ?? 1); i++) {
      results.push([await postSigned(baseUrl, registry.secretFor(sample.source_id), `/hooks/${sample.source_id}`, sample.payload), sample.note]);
    }
  }
  return results;
}

/** Send API calls in signed batches of 5,000. Returns the HTTP status of each batch. */
export async function sendCalls(baseUrl: string, registry: Registry, calls: unknown[]): Promise<(number | string)[]> {
  const secret = registry.secretFor(TRAFFIC_SOURCE_ID);
  const statuses = [];
  for (let i = 0; i < calls.length; i += 5000) {
    statuses.push(await postSigned(baseUrl, secret, `/requests/${TRAFFIC_SOURCE_ID}`, { calls: calls.slice(i, i + 5000) }));
  }
  return statuses;
}
