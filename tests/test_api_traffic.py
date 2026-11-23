"""API calls end to end: the /requests endpoint, the traffic store, the generator,
the shop's access log, the watcher's forwarding, and the API analysis tab."""

import json
import re
from datetime import datetime, timezone

import pytest

from app.models import ApiCall
from app.traffic import TrafficStore
from sample_app import shop
from scripts import generate_traffic
from scripts.watch_logs import LogTail, check_once, parse_entries, to_api_call
from tests.conftest import TEST_SECRETS, make_client, post_signed

NOW = datetime(2026, 11, 23, 12, 0, tzinfo=timezone.utc)
SECRET = TEST_SECRETS["SRC_GENERIC_SECRET"]


def api_call(**changes) -> dict:
    fields = {"app": "shop", "method": "GET", "path": "/products", "status": 200,
              "duration_ms": 42.0, "time": "2026-11-23T10:00:00Z"}
    return {**fields, **changes}


# ----------------------------------------------------------------------- POST /requests/{source}


def test_accepts_signed_batch(client):
    r = post_signed(client, "inhouse-app", {"calls": [api_call(), api_call(path="/cart")]}, "SRC_GENERIC_SECRET", "requests")
    assert r.status_code == 202 and r.json() == {"accepted": 2}
    assert len(client.app.state.traffic.calls) == 2


def test_rejects_unknown_source_and_bad_signature(client):
    body = json.dumps({"calls": [api_call()]}).encode()
    assert client.post("/requests/nope", content=body).status_code == 404
    assert client.post("/requests/inhouse-app", content=body, headers={"X-Signature": "bad"}).status_code == 401
    assert len(client.app.state.traffic.calls) == 0


@pytest.mark.parametrize("payload", [
    {"calls": [api_call(status=999)]},
    {"calls": [api_call(duration_ms=-1)]},
    {"calls": [{"app": "shop"}]},
    {"nothing": []},
    [],
])
def test_rejects_bad_batches(client, payload):
    assert post_signed(client, "inhouse-app", payload, "SRC_GENERIC_SECRET", "requests").status_code == 422
    assert len(client.app.state.traffic.calls) == 0


def test_rejects_too_large_batch(client):
    r = post_signed(client, "inhouse-app", {"calls": [api_call()] * 10_001}, "SRC_GENERIC_SECRET", "requests")
    assert r.status_code == 422


def test_method_uppercased_and_time_utc():
    c = ApiCall(**{**api_call(method="get"), "time": datetime(2026, 11, 23, 10, 0)})
    assert c.method == "GET" and c.time.tzinfo == timezone.utc


def test_traffic_store_keeps_newest():
    store = TrafficStore(max_calls=3)
    store.add([ApiCall(**api_call(app=f"a{i}")) for i in range(5)])
    assert [c.app for c in store.calls] == ["a2", "a3", "a4"]
    assert store.apps() == ["a2", "a3", "a4"]
    assert len(store.for_app("a3")) == 1


# ----------------------------------------------------------------------- generator


def test_generator_is_repeatable_and_realistic():
    calls = generate_traffic.generate(NOW, hours=24, scale=0.1, seed=1)
    assert calls == generate_traffic.generate(NOW, hours=24, scale=0.1, seed=1)
    assert {c["app"] for c in calls} == set(generate_traffic.APPS)
    times = [datetime.fromisoformat(c["time"]) for c in calls]
    assert min(times) >= NOW.replace(day=22) and max(times) <= NOW
    assert all(ApiCall(**c) for c in calls[:500])  # valid records


def test_generator_daily_curve():
    assert generate_traffic.busyness(13) > generate_traffic.busyness(4)
    assert generate_traffic.busyness(2, peak_hour=2) > generate_traffic.busyness(14, peak_hour=2)
    assert generate_traffic.hours_apart(23, 1) == 2


def test_generator_sends_in_signed_batches(client, monkeypatch):
    monkeypatch.setattr(generate_traffic, "BATCH_SIZE", 400)
    calls = generate_traffic.generate(NOW, hours=24, scale=0.02, seed=1)
    statuses = generate_traffic.send(client, SECRET, calls)
    assert len(statuses) == -(-len(calls) // 400) and set(statuses) == {202}
    assert len(client.app.state.traffic.calls) == len(calls)


# ----------------------------------------------------------------------- shop access log -> watcher


def test_access_line_becomes_api_call():
    [entry] = parse_entries("2026-11-23T10:00:00Z INFO shop.access GET /products/7 200 37ms\n")
    assert to_api_call(entry, "sample-shop") == {
        "app": "sample-shop", "method": "GET", "path": "/products/7", "status": 200,
        "duration_ms": 37.0, "time": "2026-11-23T10:00:00Z"}


@pytest.mark.parametrize("line", [
    "2026-11-23T10:00:00Z INFO shop Order 5 paid 10.00",          # not the access logger
    "2026-11-23T10:00:00Z INFO shop.access something unexpected",  # wrong shape
])
def test_other_lines_are_not_api_calls(line):
    [entry] = parse_entries(line + "\n")
    assert to_api_call(entry) is None


@pytest.fixture
def shop_log(tmp_path):
    path = tmp_path / "shop.log"
    handler = shop.setup_logging(path)
    yield path
    shop.log.removeHandler(handler)
    handler.close()


def test_shop_visit_logs_api_calls(shop_log, monkeypatch):
    monkeypatch.setattr(shop, "random_order", lambda n: {
        "id": n, "total": 10.0, "coupon": None, "shipping": "standard", "busy_connections": 5})
    shop.serve_customer(1)  # coupon bug -> checkout fails
    calls = [to_api_call(e) for e in parse_entries(shop_log.read_text())]
    calls = [c for c in calls if c]
    assert [(c["method"], c["status"]) for c in calls] == [
        ("GET", 200), ("GET", 200), ("POST", 200), ("POST", 500)]
    assert calls[-1]["path"] == "/checkout"


def test_watcher_forwards_api_calls_and_errors(shop_log, client, monkeypatch):
    monkeypatch.setattr(shop, "random_order", lambda n: {
        "id": n, "total": 10.0, "coupon": {"percent": 10} if n % 2 else None,
        "shipping": "standard", "busy_connections": 5})
    for n in range(1, 5):
        shop.serve_customer(n)
    results = check_once(LogTail(shop_log), client, SECRET, "sample-shop")

    assert any("TypeError in apply_coupon()" in r for r in results)
    assert any(re.match(r"202  API\s+\d+ API calls", r) for r in results)
    traffic = client.app.state.traffic.for_app("sample-shop")
    checkout = [c for c in traffic if c.path == "/checkout"]
    assert len(checkout) == 4 and sum(c.status == 500 for c in checkout) == 2


# ----------------------------------------------------------------------- the API analysis tab


@pytest.fixture
def loaded(registry):
    with make_client(registry) as c:
        generate_traffic.send(c, SECRET, generate_traffic.generate(NOW, hours=24, scale=0.05, seed=3))
        yield c


def test_tab_links(loaded):
    page = loaded.get("/").text
    assert 'href="/?view=analysis"' in page and ">API analysis<" in page


def test_empty_analysis_tab(client):
    assert "No API traffic yet" in client.get("/?view=analysis").text


def test_all_applications_overview(loaded):
    page = loaded.get("/?view=analysis").text
    for app in generate_traffic.APPS:
        assert f'href="/?view=analysis&amp;app={app}"' in page
    assert "Unhealthy" in page and "Healthy" in page
    assert "Busiest API" in page


def test_one_application_page(loaded):
    page = loaded.get("/?view=analysis&app=orders-service").text
    for text in ["API calls by hour of day", "Recommended optimisations", "APIs by number of calls",
                 "Peak hour (UTC)", "Quietest hour (UTC)", "Availability", "GET /orders/{id}/invoice",
                 "Speed up: very slow", "Show as table"]:
        assert text in page, text
    assert page.count('class="bar-slot"') == 24
    assert page.count('class="bar-label">Peak<') == 1


def test_cache_advice_shown_for_shared_api(loaded):
    page = loaded.get("/?view=analysis&app=auth-gateway").text
    jwks_row = page.split("GET /.well-known/jwks.json</code></td>", 1)[1].split("</tr>", 1)[0]
    assert "Yes" in jwks_row and "Cache (60 s, shared)" in jwks_row


def test_unknown_app_on_analysis_tab(loaded):
    assert "No API traffic recorded for" in loaded.get("/?view=analysis&app=nope").text


def test_app_selection_is_kept_when_switching_tabs(loaded):
    page = loaded.get("/?view=analysis&app=checkout-api").text
    assert 'href="/?app=checkout-api"' in page  # back to Alerts, same application


def test_analysis_tab_escapes_api_paths(client):
    post_signed(client, "inhouse-app", {"calls": [api_call(app="x", path="/<script>alert(1)</script>")]},
                "SRC_GENERIC_SECRET", "requests")
    page = client.get("/?view=analysis&app=x").text
    assert "<script>alert(1)</script>" not in page and "&lt;script&gt;" in page
