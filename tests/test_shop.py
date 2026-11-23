"""The sample shop: its three bugs, its warning, and the log format the watcher reads."""

import logging

import pytest

from sample_app import shop
from scripts.watch_logs import parse_entries


def good_order(**changes) -> dict:
    order = {"id": 1, "total": 100.0, "coupon": {"percent": 10}, "shipping": "standard", "busy_connections": 5}
    return {**order, **changes}


@pytest.fixture
def shop_log(tmp_path, monkeypatch):
    """Send the shop's log to a temp file; always take the fast path unless a test says otherwise."""
    monkeypatch.setattr(shop.random, "choice", lambda options: options[0])
    path = tmp_path / "logs" / "shop.log"
    handler = shop.setup_logging(path)
    yield path
    shop.log.removeHandler(handler)
    handler.close()


# ----------------------------------------------------------------------- business logic


def test_coupon_discount():
    assert shop.apply_coupon(good_order(coupon={"percent": 20})) == 80.0


def test_standard_shipping():
    assert shop.shipping_cost("standard") == 4.99


def test_db_connection_under_limit():
    assert shop.get_db_connection(shop.DB_POOL_SIZE - 1) == "db-connection"


def test_random_order_shape():
    order = shop.random_order(42)
    assert order["id"] == 42
    assert set(order) == {"id", "total", "coupon", "shipping", "busy_connections"}
    assert order["shipping"] in shop.SHIPPING_RATES


# ----------------------------------------------------------------------- the three bugs


def test_bug_1_order_without_coupon_crashes():
    with pytest.raises(TypeError, match="NoneType"):
        shop.apply_coupon(good_order(coupon=None))


def test_bug_2_pool_exhausted_at_limit():
    with pytest.raises(TimeoutError, match="connection pool exhausted"):
        shop.get_db_connection(shop.DB_POOL_SIZE)


def test_bug_3_express_rate_is_not_a_number():
    with pytest.raises(ValueError, match="could not convert string to float"):
        shop.shipping_cost("express")


# ----------------------------------------------------------------------- logging


def test_good_order_logs_info(shop_log):
    shop.process_order(good_order(id=7))
    [entry] = parse_entries(shop_log.read_text())
    assert entry["level"] == "INFO" and "Order 7 paid" in entry["message"]


def test_slow_order_logs_warning(shop_log, monkeypatch):
    monkeypatch.setattr(shop.random, "choice", lambda options: options[-1])  # the 2500 ms path
    shop.process_order(good_order(id=8))
    levels = [e["level"] for e in parse_entries(shop_log.read_text())]
    assert levels == ["WARNING", "INFO"]


def test_failed_order_log_has_parsable_stack_trace(shop_log):
    try:
        shop.process_order(good_order(id=9, coupon=None))
    except Exception:
        shop.log.exception("Order %s failed", 9)

    [entry] = parse_entries(shop_log.read_text())
    assert entry["level"] == "ERROR"
    assert entry["time"].endswith("Z")  # UTC
    assert entry["trace"][0] == "Traceback (most recent call last):"
    assert entry["trace"][-1].startswith("TypeError")


def test_setup_logging_creates_folder(tmp_path):
    path = tmp_path / "new-folder" / "shop.log"
    handler = shop.setup_logging(path)
    try:
        assert path.parent.is_dir()
        assert shop.log.level == logging.INFO
    finally:
        shop.log.removeHandler(handler)
        handler.close()
