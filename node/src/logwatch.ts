/**
 * Watch a log file and send its errors, warnings and API calls to the triage app.
 *
 * Every few seconds it reads the lines added to the log since the last check.
 *   - ERROR / WARNING: it finds the place in the code where it broke (the last "File ...,
 *     line ..." in the Python stack trace) and sends a signed alert as the in-house app source
 *     ("inhouse-app"). The same bug at the same line is de-duplicated by the app.
 *   - Access-log lines ("GET /products 200 42ms"): sent together as one batch of API calls.
 */

import fs from "node:fs";
import path from "node:path";
import { sign } from "./security.js";
import { PROJECT_ROOT } from "./settings.js";

export const SOURCE_ID = "inhouse-app";

// "2026-11-20T06:42:46Z ERROR shop Order 1003 failed"
const ENTRY_START = /^(\S+Z) (INFO|WARNING|ERROR|CRITICAL) (\S+) (.*)$/;
// '  File "/path/to/shop.py", line 52, in get_db_connection'
const FRAME = /^\s*File "(.+)", line (\d+), in (.+)$/;
// Access-log message: "GET /products/42 200 37ms"
const ACCESS = /^([A-Z]+) (\S+) (\d{3}) (\d+(?:\.\d+)?)ms$/;
const SEVERITY: Record<string, string> = { CRITICAL: "SEV1", ERROR: "SEV2", WARNING: "SEV3" };

export interface Entry {
  time: string;
  level: string;
  logger: string;
  message: string;
  trace: string[];
}

/** Split log text into entries. Lines that don't start with a timestamp (the stack trace) belong to the entry above. */
export function parseEntries(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = ENTRY_START.exec(line);
    if (m) entries.push({ time: m[1], level: m[2], logger: m[3], message: m[4], trace: [] });
    else if (entries.length) entries[entries.length - 1].trace.push(line);
  }
  return entries;
}

/** The last frame of a Python stack trace is where the error was raised. */
export function whereItBroke(trace: string[]): { file: string; line: string; function: string } | null {
  const frames = trace.map((l) => FRAME.exec(l)).filter((m): m is RegExpExecArray => m !== null);
  if (!frames.length) return null;
  const [, file, line, fn] = frames[frames.length - 1];
  const relative = path.relative(PROJECT_ROOT, file);
  return { file: relative.startsWith("..") || path.isAbsolute(relative) ? file : relative.split(path.sep).join("/"), line, function: fn };
}

/** Turn one log entry into a generic-format alert, or null if it is not a problem. */
export function toAlert(entry: Entry, service = "sample-shop"): Record<string, unknown> | null {
  const severity = SEVERITY[entry.level];
  if (!severity) return null;
  const where = whereItBroke(entry.trace);
  let title: string, resource: string, error: string;
  let labels: Record<string, string>;
  if (where) {
    error = entry.trace[entry.trace.length - 1].trim(); // e.g. "TypeError: 'NoneType' object is not subscriptable"
    const errorType = error.split(":")[0];
    title = `${errorType} in ${where.function}()`;
    resource = `${where.file}:${where.line}`;
    labels = { ...where, error_type: errorType, logger: entry.logger };
  } else {
    // No stack trace (e.g. a warning): use the message without its numbers, so repeats match.
    error = entry.message;
    title = entry.message.replace(/\d+/g, "N");
    resource = entry.logger;
    labels = { logger: entry.logger };
  }
  const description = [entry.message, ...entry.trace].join("\n");
  return {
    title,
    service,
    description: description.slice(0, 4000),
    severity,
    fired_at: entry.time,
    resource,
    labels: { ...labels, error: error.slice(0, 300) },
  };
}

/** Turn an access-log entry ("GET /products 200 42ms") into an API-call record, else null. */
export function toApiCall(entry: Entry, service = "sample-shop") {
  if (!entry.logger.endsWith("access")) return null;
  const m = ACCESS.exec(entry.message);
  if (!m) return null;
  return { app: service, method: m[1], path: m[2], status: Number(m[3]), duration_ms: Number(m[4]), time: entry.time };
}

/** Reads only what was added to a log file since the last read. */
export class LogTail {
  position = 0; // how many bytes we have already read
  leftover = ""; // a half-written last line waits for the next read

  constructor(readonly file: string) {}

  newEntries(): Entry[] {
    if (!fs.existsSync(this.file)) return [];
    const size = fs.statSync(this.file).size;
    if (size < this.position) {
      this.position = 0; // the file was recreated: start again
      this.leftover = "";
    }
    if (size === this.position) return [];
    const fd = fs.openSync(this.file, "r");
    try {
      const buffer = Buffer.alloc(size - this.position);
      fs.readSync(fd, buffer, 0, buffer.length, this.position);
      this.position = size;
      const text = this.leftover + buffer.toString("utf8");
      const cut = text.lastIndexOf("\n");
      this.leftover = text.slice(cut + 1);
      return parseEntries(cut >= 0 ? text.slice(0, cut) : "");
    } finally {
      fs.closeSync(fd);
    }
  }
}

/** POST JSON signed with the source's secret. Returns the HTTP status, or why it was not sent. */
export async function postSigned(baseUrl: string, secret: string, urlPath: string, payload: unknown): Promise<number | string> {
  const body = JSON.stringify(payload);
  try {
    const res = await fetch(new URL(urlPath, baseUrl), {
      method: "POST",
      body,
      headers: { "X-Signature": sign(secret, body), "Content-Type": "application/json" },
    });
    await res.arrayBuffer();
    return res.status;
  } catch (e) {
    return `not sent (${(e as Error).name})`;
  }
}

/** Send every new error / warning as an alert, and all new API calls in batches. One result line each. */
export async function checkOnce(tail: LogTail, baseUrl: string, secret: string, service: string): Promise<string[]> {
  const results: string[] = [];
  const apiCalls = [];
  for (const entry of tail.newEntries()) {
    const call = toApiCall(entry, service);
    if (call) {
      apiCalls.push(call);
      continue;
    }
    const alert = toAlert(entry, service);
    if (alert) {
      const status = await postSigned(baseUrl, secret, `/hooks/${SOURCE_ID}`, alert);
      results.push(`${status}  ${entry.level.padEnd(7)} ${alert.title}  @ ${alert.resource}`);
    }
  }
  for (let i = 0; i < apiCalls.length; i += 5000) {
    const batch = apiCalls.slice(i, i + 5000);
    const status = await postSigned(baseUrl, secret, `/requests/${SOURCE_ID}`, { calls: batch });
    results.push(`${status}  API     ${batch.length} API calls`);
  }
  return results;
}
