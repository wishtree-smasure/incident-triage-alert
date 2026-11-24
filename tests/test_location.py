"""Finding the exact folder, file, line and function an alert comes from."""

from datetime import datetime, timezone

from app.location import code_location
from app.models import NormalizedAlert


def alert(description="", title="Something broke", **labels) -> NormalizedAlert:
    return NormalizedAlert(source_id="s", source_type="generic", service="svc", title=title,
                           description=description, fired_at=datetime(2026, 11, 24, tzinfo=timezone.utc),
                           labels=labels)


def where(loc):
    return loc["folder"], loc["file"], loc["line"], loc["function"]


def test_labels_from_the_log_watcher_win():
    loc = code_location(alert("noise", file="sample_app/shop.py", line="52", function="apply_coupon"))
    assert where(loc) == ("sample_app/", "shop.py", 52, "apply_coupon")
    assert loc["goto"] == "sample_app/shop.py:52"


def test_java_package_becomes_the_folder():
    loc = code_location(alert(
        "412 errors in 10 min: NullPointerException at com.shop.payment.PaymentClient.authorize(PaymentClient.java:88)"))
    assert where(loc) == ("com/shop/payment/", "PaymentClient.java", 88, "PaymentClient.authorize")
    assert loc["goto"] == "com/shop/payment/PaymentClient.java:88" and "src/main/java" in loc["hint"]


def test_java_skips_library_frames():
    trace = """java.lang.NullPointerException
        at java.util.Objects.requireNonNull(Objects.java:209)
        at com.shop.orders.OrderService.place(OrderService.java:41)
        at org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:883)"""
    assert where(code_location(alert(trace))) == ("com/shop/orders/", "OrderService.java", 41, "OrderService.place")


def test_python_uses_the_last_own_frame():
    trace = """Traceback (most recent call last):
  File "/srv/app/orders/views.py", line 12, in create
    total = pricing.total(order)
  File "/srv/app/orders/pricing.py", line 52, in total
    return order["coupon"]["percent"]
  File "/usr/lib/python3.12/site-packages/x/y.py", line 3, in z
TypeError: 'NoneType' object is not subscriptable"""
    assert where(code_location(alert(trace))) == ("/srv/app/orders/", "pricing.py", 52, "total")


def test_dotnet():
    trace = "System.NullReferenceException\n   at Shop.Orders.OrderService.Create(Order o) in C:\\src\\Shop\\Orders\\OrderService.cs:line 42"
    loc = code_location(alert(trace))
    assert where(loc) == ("C:/src/Shop/Orders/", "OrderService.cs", 42, "OrderService.Create")


def test_node_skips_node_modules():
    trace = """TypeError: Cannot read properties of undefined (reading 'id')
    at Object.get (/srv/app/node_modules/lodash/get.js:10:3)
    at createOrder (/srv/app/src/orders/service.ts:31:7)"""
    loc = code_location(alert(trace))
    assert where(loc) == ("/srv/app/src/orders/", "service.ts", 31, "createOrder") and loc["column"] == 7


def test_go_and_other_languages():
    loc = code_location(alert("panic: runtime error\n\t/srv/app/orders/handler.go:42 +0x1d"))
    assert (loc["folder"], loc["file"], loc["line"]) == ("/srv/app/orders/", "handler.go", 42)


def test_infrastructure_alert_has_no_code_location():
    assert code_location(alert("CPU above 90% on i-0abc for 5 minutes", title="High CPU")) is None
