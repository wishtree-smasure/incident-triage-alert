"""Generate realistic API traffic for the last 24 hours and send it to the triage app.

Each application has a few APIs, each with its own share of traffic, typical response time
and error rate. Traffic follows a daily curve (quiet at night, busy at lunch and in the
evening), and some APIs have built-in problems so the analysis tab has something to find.

Usage (with the app running on localhost:8000):
    python scripts/generate_traffic.py
    python scripts/generate_traffic.py --hours 24 --scale 1.0 --seed 7
"""

import argparse
import json
import math
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # so "app" can be imported

from app.registry import load_registry  # noqa: E402
from app.security import sign  # noqa: E402
from app.settings import PROJECT_ROOT  # noqa: E402

SOURCE_ID = "inhouse-app"
BATCH_SIZE = 5000

# (method, path, share of the app's traffic, typical ms, server-error rate, client-error rate[, own peak hour])
# "{id}" is replaced by a random number, like real URLs. Without an own peak hour, an API
# follows the usual day: busy at lunch and in the evening.
APPS = {
    "sample-shop": {
        "calls_per_day": 20_000,
        "apis": [
            ("GET", "/products", 0.30, 60, 0.001, 0.0),        # hot, same for everyone: cache it
            ("GET", "/products/{id}", 0.25, 45, 0.001, 0.02),
            ("GET", "/categories", 0.08, 30, 0.0, 0.0),
            ("GET", "/cart", 0.10, 80, 0.002, 0.0),
            ("POST", "/cart/items", 0.08, 120, 0.003, 0.03),
            ("POST", "/checkout", 0.04, 900, 0.08, 0.01),        # the shop's bugs: slow and failing
            ("GET", "/orders/{id}", 0.05, 150, 0.004, 0.02),
            ("GET", "/health", 0.10, 5, 0.0, 0.0),
        ],
    },
    "checkout-api": {
        "calls_per_day": 15_000,
        "apis": [
            ("GET", "/checkout/{id}/status", 0.30, 40, 0.002, 0.0),
            ("GET", "/payment-methods", 0.25, 90, 0.0, 0.0),     # shared list: cache it
            ("POST", "/checkout", 0.20, 450, 0.04, 0.02),         # 5xx after the bad deploy
            ("POST", "/payments/authorize", 0.15, 700, 0.03, 0.01),
            ("GET", "/health", 0.10, 5, 0.0, 0.0),
        ],
    },
    "orders-service": {
        "calls_per_day": 12_000,
        "apis": [
            ("GET", "/orders", 0.30, 1400, 0.02, 0.0),            # slow list: DB pool pressure
            ("GET", "/orders/{id}", 0.30, 300, 0.01, 0.03),
            ("POST", "/orders", 0.15, 600, 0.02, 0.02),
            ("GET", "/orders/{id}/invoice", 0.10, 2400, 0.01, 0.0, 2),  # very slow, nightly batch at 02:00
            ("GET", "/health", 0.15, 5, 0.0, 0.0),
        ],
    },
    "auth-gateway": {
        "calls_per_day": 30_000,
        "apis": [
            ("POST", "/oauth/token", 0.40, 120, 0.002, 0.12, 9),  # 401/403 spike; logins peak at 09:00
            ("GET", "/.well-known/jwks.json", 0.20, 15, 0.0, 0.0),  # public keys: cache it
            ("GET", "/userinfo", 0.25, 60, 0.001, 0.05),
            ("POST", "/logout", 0.05, 40, 0.0, 0.0),
            ("GET", "/health", 0.10, 5, 0.0, 0.0),
        ],
    },
    "billing-service": {
        "calls_per_day": 6_000,
        "apis": [
            ("GET", "/invoices/{id}", 0.35, 180, 0.003, 0.02),
            ("POST", "/invoices", 0.15, 400, 0.01, 0.02),
            ("POST", "/reconciliation/run", 0.05, 4200, 0.06, 0.0, 3),  # nightly job at 03:00 that crashes
            ("GET", "/plans", 0.30, 35, 0.0, 0.0),                 # same for everyone: cache it
            ("GET", "/health", 0.15, 5, 0.0, 0.0),
        ],
    },
    "notification-service": {
        "calls_per_day": 9_000,
        "apis": [
            ("POST", "/emails", 0.45, 650, 0.015, 0.01),           # queue backlog: slow at peak
            ("POST", "/sms", 0.15, 300, 0.005, 0.02),
            ("GET", "/templates/{id}", 0.25, 25, 0.0, 0.01),
            ("GET", "/health", 0.15, 5, 0.0, 0.0),
        ],
    },
    "reporting-service": {
        "calls_per_day": 2_500,
        "apis": [
            ("GET", "/reports/{id}", 0.40, 1200, 0.004, 0.02),     # heavy queries
            ("POST", "/reports/export", 0.15, 3500, 0.01, 0.01, 6),  # export batch at 06:00
            ("GET", "/dashboards", 0.30, 220, 0.0, 0.0),
            ("GET", "/health", 0.15, 5, 0.0, 0.0),
        ],
    },
}


def hours_apart(a: int, b: int) -> int:
    """Distance on a 24-hour clock: 23:00 and 01:00 are 2 hours apart."""
    return min(abs(a - b), 24 - abs(a - b))


def busyness(hour: int, peak_hour: int | None = None) -> float:
    """Daily curve (UTC). Default: quiet at night, a lunch peak around 13:00 and an evening
    peak around 20:00. With peak_hour: one peak at that hour."""
    if peak_hour is not None:
        return 0.15 + math.exp(-(hours_apart(hour, peak_hour) / 2.5) ** 2)
    lunch = math.exp(-(hours_apart(hour, 13) / 2.5) ** 2)
    evening = 0.8 * math.exp(-(hours_apart(hour, 20) / 2.0) ** 2)
    return 0.15 + lunch + evening


def generate(now: datetime, hours: int = 24, scale: float = 1.0, seed: int = 7) -> list[dict]:
    """API-call records for every app, spread over the last `hours` hours."""
    rng = random.Random(seed)
    start = now - timedelta(hours=hours)
    hour_starts = [start + timedelta(hours=h) for h in range(hours)]
    calls = []

    for app, profile in APPS.items():
        app_calls = profile["calls_per_day"] * scale * hours / 24
        for method, path, share, typical_ms, server_err, client_err, *own_peak in profile["apis"]:
            peak = own_peak[0] if own_peak else None
            curve = [busyness(hs.hour, peak) for hs in hour_starts]
            for hour_start, weight in zip(hour_starts, curve):
                load = weight / max(curve)  # 0..1, busier hours are slower and fail more
                for _ in range(round(app_calls * share * weight / sum(curve))):
                    roll = rng.random()
                    if roll < server_err * (0.5 + load):
                        status = rng.choice([500, 502, 503])
                    elif roll < server_err * (0.5 + load) + client_err:
                        status = rng.choice([400, 401, 403, 404])
                    else:
                        status = 200
                    duration = rng.lognormvariate(math.log(typical_ms), 0.45) * (1 + 0.6 * load)
                    calls.append({
                        "app": app,
                        "method": method,
                        "path": path.replace("{id}", str(rng.randint(1, 99_999))),
                        "status": status,
                        "duration_ms": round(duration, 1),
                        "time": (hour_start + timedelta(seconds=rng.uniform(0, 3600))).isoformat(),
                    })
    calls.sort(key=lambda c: c["time"])
    return calls


def send(client: httpx.Client, secret: str, calls: list[dict]) -> list[int]:
    """Send the calls in signed batches. Returns the HTTP status of each batch."""
    statuses = []
    for i in range(0, len(calls), BATCH_SIZE):
        body = json.dumps({"calls": calls[i:i + BATCH_SIZE]}).encode()
        response = client.post(
            f"/requests/{SOURCE_ID}",
            content=body,
            headers={"X-Signature": sign(secret, body), "Content-Type": "application/json"},
        )
        statuses.append(response.status_code)
    return statuses


def main() -> None:
    parser = argparse.ArgumentParser(description="Send 24 hours of sample API traffic to the triage app.")
    parser.add_argument("--url", default="http://localhost:8000")
    parser.add_argument("--hours", type=int, default=24)
    parser.add_argument("--scale", type=float, default=1.0, help="multiply the number of calls")
    parser.add_argument("--seed", type=int, default=7, help="same seed = same traffic")
    args = parser.parse_args()

    load_dotenv(PROJECT_ROOT / ".env")
    secret = load_registry(PROJECT_ROOT / "config" / "sources.yaml").secret_for(SOURCE_ID)

    calls = generate(datetime.now(timezone.utc), args.hours, args.scale, args.seed)
    with httpx.Client(base_url=args.url, timeout=60) as client:
        statuses = send(client, secret, calls)
    print(f"Sent {len(calls):,} API calls for {len(APPS)} applications in {len(statuses)} batches: {statuses}")


if __name__ == "__main__":
    main()
