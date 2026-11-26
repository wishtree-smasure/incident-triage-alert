/** The watcher's incremental reading (LogTail) and one check cycle (checkOnce). */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkOnce, LogTail, parseEntries, toAlert } from "../src/logwatch.js";
import { PROJECT_ROOT } from "../src/settings.js";
import { makeApp, TEST_SECRETS, type TestApp } from "./helpers.js";

const SECRET = TEST_SECRETS.SRC_GENERIC_SECRET;
const ERROR_ENTRY = `2026-11-20T06:00:01Z ERROR shop Order 1 failed
Traceback (most recent call last):
  File "/x/shop.py", line 46, in apply_coupon
    discount = order["coupon"]["percent"]
TypeError: 'NoneType' object is not subscriptable
`;
const INFO_ENTRY = "2026-11-20T06:00:02Z INFO shop Order 2 paid 10.00\n";
const tmpLog = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tail-")), "app.log");

describe("LogTail", () => {
  it("missing file gives nothing", () => expect(new LogTail(tmpLog()).newEntries()).toEqual([]));

  it("reads only new lines", () => {
    const log = tmpLog();
    fs.writeFileSync(log, ERROR_ENTRY);
    const tail = new LogTail(log);
    expect(tail.newEntries()).toHaveLength(1);
    expect(tail.newEntries()).toEqual([]); // nothing new
    fs.appendFileSync(log, INFO_ENTRY);
    const entries = tail.newEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("INFO");
  });

  it("half-written line waits for the next read", () => {
    const log = tmpLog();
    fs.writeFileSync(log, "2026-11-20T06:00:02Z INFO shop Order 2 pa"); // no newline yet
    const tail = new LogTail(log);
    expect(tail.newEntries()).toEqual([]);
    fs.appendFileSync(log, "id 10.00\n");
    expect(tail.newEntries().map((e) => e.message)).toEqual(["Order 2 paid 10.00"]);
  });

  it("recreated file is read from the start", () => {
    const log = tmpLog();
    fs.writeFileSync(log, ERROR_ENTRY + INFO_ENTRY);
    const tail = new LogTail(log);
    tail.newEntries();
    fs.writeFileSync(log, INFO_ENTRY); // rotated: smaller than before
    expect(tail.newEntries().map((e) => e.message)).toEqual(["Order 2 paid 10.00"]);
  });

  it("multi-byte characters are read whole", () => {
    const log = tmpLog();
    fs.writeFileSync(log, "2026-11-20T06:00:02Z INFO shop Café paid 10.00 €\n");
    expect(new LogTail(log).newEntries()[0].message).toBe("Café paid 10.00 €");
  });
});

describe("parsing edge cases", () => {
  it("lines before the first timestamp are ignored", () => {
    const entries = parseEntries(`garbage line\n${INFO_ENTRY}`.trimEnd());
    expect(entries).toHaveLength(1);
    expect(entries[0].trace).toEqual([]);
  });

  it("CRITICAL is SEV1", () => {
    const [entry] = parseEntries("2026-11-20T06:00:00Z CRITICAL shop Payments are down");
    expect(toAlert(entry)!.severity).toBe("SEV1");
  });

  it("error without a stack trace uses the message", () => {
    const [entry] = parseEntries("2026-11-20T06:00:00Z ERROR shop Payment 123 rejected by bank");
    const alert = toAlert(entry) as any;
    expect(alert.title).toBe("Payment N rejected by bank");
    expect(alert.resource).toBe("shop");
    expect("file" in alert.labels).toBe(false);
  });

  it("project paths become relative, others stay absolute", () => {
    const inside = `  File "${PROJECT_ROOT}/sample_app/shop.py", line 1, in f\nValueError: x`;
    const outside = '  File "/usr/lib/python3/json/decoder.py", line 2, in g\nValueError: y';
    for (const [frame, expected] of [[inside, "sample_app/shop.py"], [outside, "/usr/lib/python3/json/decoder.py"]]) {
      const [entry] = parseEntries(`2026-11-20T06:00:00Z ERROR shop boom\n${frame}`);
      expect((toAlert(entry) as any).labels.file).toBe(expected);
    }
  });

  it("long text is truncated", () => {
    const [entry] = parseEntries(`2026-11-20T06:00:00Z ERROR shop ${"x".repeat(10_000)}`);
    const alert = toAlert(entry) as any;
    expect(alert.description).toHaveLength(4000);
    expect(alert.labels.error).toHaveLength(300);
  });

  it("service name is passed through", () => {
    const [entry] = parseEntries(ERROR_ENTRY.trimEnd());
    expect(toAlert(entry, "billing-api")!.service).toBe("billing-api");
  });
});

describe("checkOnce", () => {
  let app: TestApp;
  let url: string;
  beforeAll(async () => {
    app = await makeApp();
    url = await app.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(() => app.close());

  it("sends errors and skips info", async () => {
    const log = tmpLog();
    fs.writeFileSync(log, ERROR_ENTRY + INFO_ENTRY);
    const results = await checkOnce(new LogTail(log), url, SECRET, "sample-shop");
    expect(results).toHaveLength(1);
    expect(results[0].startsWith("202  ERROR")).toBe(true);
    expect(results[0]).toContain("shop.py:46");
  });

  it("survives the app being down", async () => {
    const log = tmpLog();
    fs.writeFileSync(log, ERROR_ENTRY);
    const [result] = await checkOnce(new LogTail(log), "http://127.0.0.1:1", SECRET, "sample-shop");
    expect(result.startsWith("not sent (")).toBe(true);
  });

  it("reports a rejected signature", async () => {
    const log = tmpLog();
    fs.writeFileSync(log, ERROR_ENTRY);
    const [result] = await checkOnce(new LogTail(log), url, "wrong-secret", "sample-shop");
    expect(result.startsWith("401")).toBe(true);
  });
});
