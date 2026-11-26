import { expect, it } from "vitest";
import { parseEntries, toAlert } from "../src/logwatch.js";
import { makeApp, postSigned } from "./helpers.js";

export const LOG = `2026-11-20T06:42:45Z INFO shop Order 1002 paid 37.04
2026-11-20T06:42:47Z ERROR shop Order 1004 failed
Traceback (most recent call last):
  File "/somewhere/sample_app/shop.py", line 63, in process_order
    price = apply_coupon(order) + shipping_cost(order["shipping"])
  File "/somewhere/sample_app/shop.py", line 46, in apply_coupon
    discount = order["coupon"]["percent"]
TypeError: 'NoneType' object is not subscriptable
2026-11-20T06:42:50Z WARNING shop Slow order processing: order 1007 took 2541 ms (limit 2000 ms)
2026-11-20T06:42:52Z ERROR shop Order 1009 failed
Traceback (most recent call last):
  File "/somewhere/sample_app/shop.py", line 46, in apply_coupon
    discount = order["coupon"]["percent"]
TypeError: 'NoneType' object is not subscriptable
`;

it("parse entries keeps the stack trace with its entry", () => {
  const entries = parseEntries(LOG.trimEnd());
  expect(entries.map((e) => e.level)).toEqual(["INFO", "ERROR", "WARNING", "ERROR"]);
  expect(entries[1].trace.at(-1)).toBe("TypeError: 'NoneType' object is not subscriptable");
  expect(entries[0].trace).toEqual([]);
});

it("info lines are not alerts", () => expect(toAlert(parseEntries(LOG)[0])).toBeNull());

it("error alert says where it breaks", () => {
  const alert = toAlert(parseEntries(LOG)[1]) as any;
  expect(alert.title).toBe("TypeError in apply_coupon()");
  expect(alert.severity).toBe("SEV2");
  expect(alert.labels.line).toBe("46");
  expect(alert.labels.function).toBe("apply_coupon");
  expect(alert.labels.error).toBe("TypeError: 'NoneType' object is not subscriptable");
  expect(alert.resource.endsWith("shop.py:46")).toBe(true);
  expect(alert.description).toContain("Traceback");
});

it("warning alert has a stable title", () => {
  const alert = toAlert(parseEntries(LOG)[2]) as any;
  expect(alert.severity).toBe("SEV3");
  expect(alert.title).toBe("Slow order processing: order N took N ms (limit N ms)");
});

it("same bug twice is one investigation, with a detail page", async () => {
  const entries = parseEntries(LOG.trimEnd());
  const app = await makeApp();
  const ids = [];
  for (const entry of [entries[1], entries[3]]) {
    const r = await postSigned(app, "inhouse-app", toAlert(entry));
    expect(r.statusCode).toBe(202);
    ids.push(r.json().investigation_id);
  }
  expect(ids[0]).toBe(ids[1]);
  const page = (await app.inject(`/investigations/${ids[0]}`)).body;
  expect(page).toContain("shop.py:46");
  expect(page).toContain("apply_coupon()");
  expect(page).toContain("seen 2 times");
  expect(page).toContain("Traceback");
  expect((await app.inject("/investigations/does-not-exist")).statusCode).toBe(404);
  await app.close();
});
