"""API analysis rules: grouping, percentiles, health, cacheability, advice, peaks."""

from datetime import datetime, timedelta, timezone

import pytest

from app import analysis
from app.analysis import api_name, cacheability, health, percentile
from app.models import ApiCall, Investigation, NormalizedAlert

T0 = datetime(2026, 11, 23, 0, 0, tzinfo=timezone.utc)


def call(path="/products", method="GET", status=200, ms=50.0, hour=12, app="shop", minute=0) -> ApiCall:
    return ApiCall(app=app, method=method, path=path, status=status, duration_ms=ms,
                   time=T0 + timedelta(hours=hour, minutes=minute))


def alert_for(app: str, severity: str | None, status: str = "queued") -> Investigation:
    a = NormalizedAlert(source_id="s", source_type="generic", service=app, title="t",
                        severity_hint=severity, fired_at=T0)
    return Investigation(id=f"i-{app}-{severity}", source_id="s", service=app, alert=a, status=status)


# ----------------------------------------------------------------------- grouping


@pytest.mark.parametrize("path, expected", [
    ("/products", "/products"),
    ("/products/123", "/products/{id}"),
    ("/orders/42/invoice", "/orders/{id}/invoice"),
    ("/users/3fa85f64-5717-4562-b3fc-2c963f66afa6", "/users/{id}"),
    ("/products?page=2", "/products"),
    ("/products/", "/products"),
    ("/", "/"),
    ("/v2/products", "/v2/products"),  # short words with digits are not ids
])
def test_api_name_groups_ids(path, expected):
    assert api_name(path) == expected


# ----------------------------------------------------------------------- numbers


def test_percentile():
    values = sorted(range(1, 101))  # 1..100
    assert percentile(values, 0.50) == 50
    assert percentile(values, 0.95) == 95
    assert percentile(values, 0.99) == 99
    assert percentile([], 0.95) == 0.0
    assert percentile([7], 0.95) == 7


def test_summarize_counts_errors_and_peak():
    calls = [call(hour=9)] * 3 + [call(hour=14, status=500), call(hour=14, status=404), call(hour=14)]
    s = analysis.summarize(calls * 1)
    assert s["calls"] == 6
    assert s["error_rate"] == pytest.approx(1 / 6)
    assert s["client_error_rate"] == pytest.approx(1 / 6)
    assert s["peak_hour"] in (9, 14) and s["peak_count"] == 3


# ----------------------------------------------------------------------- health


@pytest.mark.parametrize("server, p95, client, stoppers, expected", [
    (0.0, 100, 0.0, 0, "healthy"),
    (0.01, 100, 0.0, 0, "degraded"),   # 1% server errors
    (0.0, 800, 0.0, 0, "degraded"),    # slow
    (0.0, 100, 0.10, 0, "degraded"),   # many client errors
    (0.05, 100, 0.0, 0, "unhealthy"),  # 5% server errors
    (0.0, 2000, 0.0, 0, "unhealthy"),  # very slow
    (0.0, 100, 0.0, 1, "unhealthy"),   # open show stopper
])
def test_health_rules(server, p95, client, stoppers, expected):
    assert health(server, p95, client, stoppers) == expected


# ----------------------------------------------------------------------- cacheability


@pytest.mark.parametrize("method, path, expected", [
    ("GET", "/products", "yes"),
    ("GET", "/products/{id}", "yes"),
    ("GET", "/.well-known/jwks.json", "yes"),
    ("GET", "/payment-methods", "yes"),
    ("GET", "/cart", "per-user"),
    ("GET", "/orders/{id}", "per-user"),
    ("GET", "/userinfo", "per-user"),
    ("GET", "/checkout/{id}/status", "no"),  # live state
    ("GET", "/health", "no"),
    ("POST", "/products", "no"),
    ("DELETE", "/cart/items/{id}", "no"),
])
def test_cacheability(method, path, expected):
    label, reason = cacheability(method, path)
    assert label == expected and reason


# ----------------------------------------------------------------------- one application


def test_hot_shared_get_is_recommended_for_caching():
    calls = [call("/products")] * 80 + [call("/cart", method="POST")] * 20
    result = analysis.analyze_app("shop", calls, [])
    products = next(a for a in result["apis"] if a["path"] == "/products")
    assert products["cache"] == "yes" and products["share"] == pytest.approx(0.8)
    assert products["actions"] == ["Cache (60 s, shared)"]
    assert "Cache it: 80%" in products["advice"][0]


def test_rare_api_is_not_worth_caching():
    calls = [call("/cart", method="POST")] * 99 + [call("/categories")]
    categories = next(a for a in analysis.analyze_app("shop", calls, [])["apis"] if a["path"] == "/categories")
    assert categories["cache"] == "yes" and categories["advice"] == []


def test_slow_write_gets_background_job_advice():
    calls = [call("/reports", method="POST", ms=3000)] * 10
    api = analysis.analyze_app("shop", calls, [])["apis"][0]
    assert api["health"] == "unhealthy"
    assert api["actions"] == ["Move to background job"]


def test_most_urgent_recommendations_come_first():
    calls = ([call("/products")] * 50  # cacheable
             + [call("/orders", ms=900)] * 30  # slow
             + [call("/checkout", method="POST", status=500)] * 2 + [call("/checkout", method="POST")] * 18)
    recs = analysis.analyze_app("shop", calls, [])["recommendations"]
    texts = [r["text"] for r in recs]
    assert "server errors" in texts[0]
    first_cache = next(i for i, text in enumerate(texts) if text.startswith("Cache"))
    assert all(text.startswith("Cache") for text in texts[first_cache:])  # caching tips come last
    assert any("Slow (p95" in text for text in texts[:first_cache])


def test_hourly_traffic_peak_and_quiet_hours():
    calls = [call(hour=13)] * 10 + [call(hour=20)] * 6 + [call(hour=4)] * 1
    result = analysis.analyze_app("shop", calls, [])
    assert len(result["hourly"]) == 24
    assert result["hourly"][13] == {"hour": 13, "calls": 10, "height": 100}
    assert result["hourly"][20]["height"] == 60
    assert result["overview"]["peak_hour"] == 13
    assert result["quiet_hour"] == 4


def test_traffic_spike_recommends_scaling():
    calls = [call(hour=h) for h in range(24)] + [call(hour=13)] * 30
    recs = analysis.analyze_app("shop", calls, [])["recommendations"]
    assert recs[0]["api"] == "Whole application" and "13:00 UTC" in recs[0]["text"]


def test_calls_per_minute_and_availability():
    calls = [call(minute=m) for m in range(0, 60)]  # 60 calls over 59 minutes
    calls[0] = call(minute=0, status=503)
    result = analysis.analyze_app("shop", calls, [])
    assert result["calls_per_min"] == pytest.approx(60 / 59)
    assert result["availability"] == pytest.approx(59 / 60)
    assert result["status_groups"] == {"2xx": 59, "3xx": 0, "4xx": 0, "5xx": 1}


def test_open_show_stopper_makes_app_unhealthy():
    calls = [call()] * 10  # perfectly healthy traffic
    alerts = [alert_for("shop", "SEV1"), alert_for("shop", "SEV3"),
              alert_for("shop", "SEV1", status="concluded"),  # closed: does not count
              alert_for("other", "SEV1")]  # another app: does not count
    result = analysis.analyze_app("shop", calls, alerts)
    assert result["overview"]["health"] == "unhealthy"
    assert (result["open_alerts"], result["show_stoppers"]) == (2, 1)


def test_highlights():
    calls = [call("/a", ms=10)] * 5 + [call("/b", ms=900, status=500)] + [call("/b", ms=900)] * 2
    result = analysis.analyze_app("shop", calls, [])
    assert result["apis"][0]["path"] == "/a"  # busiest first
    assert result["slowest"]["path"] == "/b"
    assert result["most_errors"]["path"] == "/b"


def test_no_errors_means_no_most_errors_highlight():
    assert analysis.analyze_app("shop", [call()] * 3, [])["most_errors"] is None


# ----------------------------------------------------------------------- all applications


def test_overview_puts_least_healthy_first():
    by_app = {
        "fast": [call(app="fast")] * 10,
        "slow": [call(app="slow", ms=3000)] * 10,
        "meh": [call(app="meh", ms=900)] * 10,
    }
    rows = analysis.overview_of_apps(by_app, [])
    assert [r["app"] for r in rows] == ["slow", "meh", "fast"]
    assert rows[0]["top_api"] == "GET /products"
