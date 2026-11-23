import json

from app.security import sign
from scripts.watch_logs import parse_entries, to_alert
from tests.conftest import TEST_SECRETS, make_client

LOG = """\
2026-11-20T06:42:45Z INFO shop Order 1002 paid 37.04
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
"""


def test_parse_entries_keeps_stack_trace_with_its_entry():
    entries = parse_entries(LOG)
    assert [e["level"] for e in entries] == ["INFO", "ERROR", "WARNING", "ERROR"]
    assert entries[1]["trace"][-1] == "TypeError: 'NoneType' object is not subscriptable"
    assert entries[0]["trace"] == []


def test_info_lines_are_not_alerts():
    assert to_alert(parse_entries(LOG)[0]) is None


def test_error_alert_says_where_it_breaks():
    alert = to_alert(parse_entries(LOG)[1])
    assert alert["title"] == "TypeError in apply_coupon()"
    assert alert["severity"] == "SEV2"
    assert alert["labels"]["line"] == "46"
    assert alert["labels"]["function"] == "apply_coupon"
    assert alert["labels"]["error"] == "TypeError: 'NoneType' object is not subscriptable"
    assert alert["resource"].endswith("shop.py:46")
    assert "Traceback" in alert["description"]


def test_warning_alert_has_stable_title():
    alert = to_alert(parse_entries(LOG)[2])
    assert alert["severity"] == "SEV3"
    assert alert["title"] == "Slow order processing: order N took N ms (limit N ms)"


def test_same_bug_twice_is_one_investigation_with_detail_page(registry):
    entries = parse_entries(LOG)
    secret = TEST_SECRETS["SRC_GENERIC_SECRET"]
    with make_client(registry) as client:
        ids = []
        for entry in (entries[1], entries[3]):  # the same TypeError at the same line
            body = json.dumps(to_alert(entry)).encode()
            r = client.post("/hooks/inhouse-app", content=body, headers={"X-Signature": sign(secret, body)})
            assert r.status_code == 202
            ids.append(r.json()["investigation_id"])
        assert ids[0] == ids[1]

        page = client.get(f"/investigations/{ids[0]}").text
        assert "shop.py:46" in page and "apply_coupon()" in page
        assert "seen 2 times" in page
        assert "Traceback" in page

        assert client.get("/investigations/does-not-exist").status_code == 404
