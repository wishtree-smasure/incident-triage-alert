/** Finding the exact folder, file, line and function an alert comes from. */

import { expect, it } from "vitest";
import { codeLocation } from "../src/location.js";

const alert = (description = "", labels: Record<string, string> = {}, title = "Something broke") => ({ title, description, labels });
const where = (loc: ReturnType<typeof codeLocation>) => [loc!.folder, loc!.file, loc!.line, loc!.function];

it("labels from the log watcher win", () => {
  const loc = codeLocation(alert("noise", { file: "sample_app/shop.py", line: "52", function: "apply_coupon" }));
  expect(where(loc)).toEqual(["sample_app/", "shop.py", 52, "apply_coupon"]);
  expect(loc!.goto).toBe("sample_app/shop.py:52");
});

it("a Java package becomes the folder", () => {
  const loc = codeLocation(alert("412 errors in 10 min: NullPointerException at com.shop.payment.PaymentClient.authorize(PaymentClient.java:88)"));
  expect(where(loc)).toEqual(["com/shop/payment/", "PaymentClient.java", 88, "PaymentClient.authorize"]);
  expect(loc!.goto).toBe("com/shop/payment/PaymentClient.java:88");
  expect(loc!.hint).toContain("src/main/java");
});

it("Java skips library frames", () => {
  const trace = `java.lang.NullPointerException
        at java.util.Objects.requireNonNull(Objects.java:209)
        at com.shop.orders.OrderService.place(OrderService.java:41)
        at org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:883)`;
  expect(where(codeLocation(alert(trace)))).toEqual(["com/shop/orders/", "OrderService.java", 41, "OrderService.place"]);
});

it("Python uses the last own frame", () => {
  const trace = `Traceback (most recent call last):
  File "/srv/app/orders/views.py", line 12, in create
    total = pricing.total(order)
  File "/srv/app/orders/pricing.py", line 52, in total
    return order["coupon"]["percent"]
  File "/usr/lib/python3.12/site-packages/x/y.py", line 3, in z
TypeError: 'NoneType' object is not subscriptable`;
  expect(where(codeLocation(alert(trace)))).toEqual(["/srv/app/orders/", "pricing.py", 52, "total"]);
});

it(".NET", () => {
  const trace = "System.NullReferenceException\n   at Shop.Orders.OrderService.Create(Order o) in C:\\src\\Shop\\Orders\\OrderService.cs:line 42";
  expect(where(codeLocation(alert(trace)))).toEqual(["C:/src/Shop/Orders/", "OrderService.cs", 42, "OrderService.Create"]);
});

it("Node skips node_modules", () => {
  const trace = `TypeError: Cannot read properties of undefined (reading 'id')
    at Object.get (/srv/app/node_modules/lodash/get.js:10:3)
    at createOrder (/srv/app/src/orders/service.ts:31:7)`;
  const loc = codeLocation(alert(trace));
  expect(where(loc)).toEqual(["/srv/app/src/orders/", "service.ts", 31, "createOrder"]);
  expect(loc!.column).toBe(7);
});

it("Go and other languages", () => {
  const loc = codeLocation(alert("panic: runtime error\n\t/srv/app/orders/handler.go:42 +0x1d"));
  expect([loc!.folder, loc!.file, loc!.line]).toEqual(["/srv/app/orders/", "handler.go", 42]);
});

it("an infrastructure alert has no code location", () => {
  expect(codeLocation(alert("CPU above 90% on i-0abc for 5 minutes", {}, "High CPU"))).toBeNull();
});
