"""A tiny fake online shop that processes random orders forever and writes a log file.

It has three real bugs on purpose, so the log fills up with real Python errors:
  1. apply_coupon      - crashes when an order has no coupon (coupon is None)
  2. get_db_connection - the connection pool runs out under load
  3. shipping_cost     - the "express" rate in the config is not a number
It also logs a warning when an order is slow, and one access-log line per API call
(e.g. "GET /products 200 42ms") for the API analysis tab.

Run:  python sample_app/shop.py          (writes sample_app/logs/shop.log, Ctrl+C to stop)
"""

import logging
import random
import time
from pathlib import Path

LOG_FILE = Path(__file__).parent / "logs" / "shop.log"

SHIPPING_RATES = {"standard": "4.99", "express": "9,99"}
DB_POOL_SIZE = 20

log = logging.getLogger("shop")
access = logging.getLogger("shop.access")  # one line per API call, written to the same log file


def setup_logging(path: Path = LOG_FILE) -> logging.Handler:
    path.parent.mkdir(exist_ok=True)
    handler = logging.FileHandler(path)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s", "%Y-%m-%dT%H:%M:%SZ")
    formatter.converter = time.gmtime  # timestamps in UTC
    handler.setFormatter(formatter)
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    return handler


def random_order(order_id: int) -> dict:
    return {
        "id": order_id,
        "total": round(random.uniform(10, 300), 2),
        "coupon": random.choice([{"percent": 10}, {"percent": 20}, None]),
        "shipping": random.choice(["standard"] * 9 + ["express"]),
        "busy_connections": random.randint(5, 21),
    }


def apply_coupon(order: dict) -> float:
    discount = order["coupon"]["percent"]
    return order["total"] * (100 - discount) / 100


def get_db_connection(busy_connections: int) -> str:
    if busy_connections >= DB_POOL_SIZE:
        raise TimeoutError(f"connection pool exhausted ({busy_connections}/{DB_POOL_SIZE} in use)")
    return "db-connection"


def shipping_cost(method: str) -> float:
    return float(SHIPPING_RATES[method])


def process_order(order: dict) -> None:
    started = time.monotonic()
    get_db_connection(order["busy_connections"])
    price = apply_coupon(order) + shipping_cost(order["shipping"])
    elapsed_ms = (time.monotonic() - started) * 1000 + random.choice([40] * 9 + [2500])
    if elapsed_ms > 2000:
        log.warning("Slow order processing: order %s took %d ms (limit 2000 ms)", order["id"], elapsed_ms)
    log.info("Order %s paid %.2f", order["id"], price)


def log_api_call(method: str, path: str, status: int, duration_ms: float) -> None:
    access.info("%s %s %d %dms", method, path, status, duration_ms)


def serve_customer(order_id: int) -> None:
    """One customer visit: browse, add to cart, check out. Every step is an API call."""
    product = random.randint(1, 500)
    log_api_call("GET", "/products", 200, random.randint(20, 90))
    log_api_call("GET", f"/products/{product}", 200, random.randint(15, 60))
    log_api_call("POST", "/cart/items", 200, random.randint(60, 150))

    started = time.monotonic()
    try:
        process_order(random_order(order_id))
        status = 200
    except Exception:
        log.exception("Order %s failed", order_id)
        status = 500
    log_api_call("POST", "/checkout", status, (time.monotonic() - started) * 1000 + random.randint(150, 400))

    if status == 200:
        log_api_call("GET", f"/orders/{order_id}", 200, random.randint(80, 200))


def main() -> None:
    setup_logging()
    print(f"Shop running, writing logs to {LOG_FILE} (Ctrl+C to stop)")
    order_id = 1000
    while True:
        order_id += 1
        serve_customer(order_id)
        time.sleep(1)


if __name__ == "__main__":
    main()
