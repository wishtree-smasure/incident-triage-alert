"""The whole flow, as in the demo:
shop writes errors -> watcher reads the log -> app receives alerts -> dashboard shows them."""

import re

import pytest

from sample_app import shop
from scripts.send_samples import send_all
from scripts.watch_logs import LogTail, check_once
from tests.conftest import TEST_SECRETS


@pytest.fixture
def shop_log(tmp_path):
    path = tmp_path / "shop.log"
    handler = shop.setup_logging(path)
    yield path
    shop.log.removeHandler(handler)
    handler.close()


def run_order(order: dict) -> None:
    """Same as the shop's main loop does for one order."""
    try:
        shop.process_order(order)
    except Exception:
        shop.log.exception("Order %s failed", order["id"])


def order(n, **changes):
    return {"id": n, "total": 50.0, "coupon": {"percent": 10}, "shipping": "standard",
            "busy_connections": 5, **changes}


def test_shop_bugs_reach_the_dashboard_with_where_and_fix(shop_log, client, monkeypatch):
    monkeypatch.setattr(shop.random, "choice", lambda options: options[0])  # no slow orders
    tail = LogTail(shop_log)

    # First check: one of each bug, plus a good order
    run_order(order(1))
    run_order(order(2, coupon=None))
    run_order(order(3, busy_connections=shop.DB_POOL_SIZE))
    run_order(order(4, shipping="express"))
    results = check_once(tail, client, TEST_SECRETS["SRC_GENERIC_SECRET"], "sample-shop")
    assert len(results) == 3 and all(r.startswith("202") for r in results)

    # Second check: the coupon bug happens again -> same row, count goes up
    run_order(order(5, coupon=None))
    check_once(tail, client, TEST_SECRETS["SRC_GENERIC_SECRET"], "sample-shop")

    page = client.get("/?app=sample-shop").text
    for title, where, fix in [
        ("TypeError in apply_coupon()", "sample_app/shop.py:", "Check for None"),
        ("TimeoutError in get_db_connection()", "sample_app/shop.py:", "Find connections that are not released"),
        ("ValueError in shipping_cost()", "sample_app/shop.py:", "Correct the value in the config"),
    ]:
        assert title in page and fix in page
    assert page.count("sample_app/shop.py:") == 3

    coupon = next(i for i in client.app.state.store.newest_first() if "apply_coupon" in i.alert.title)
    assert coupon.dedup_count == 2
    assert re.fullmatch(r"sample_app/shop\.py:\d+", coupon.alert.resource)
    assert coupon.alert.labels["function"] == "apply_coupon"


def test_send_samples_script_loads_dashboard(client, registry):
    results = send_all(client, registry)
    assert results and all(status == 202 for status, _ in results)

    page = client.get("/").text
    assert "Show stoppers ·" in page
    for source_name in ["Datadog prod", "AWS prod", "Azure prod", "In-house logs"]:
        assert source_name in page
