import json

import pytest

from app.security import sign
from tests.conftest import TEST_SECRETS, load_payload, make_client


@pytest.fixture
def client(registry):
    with make_client(registry) as c:
        yield c


def post_alert(client, source_id, payload, secret):
    body = json.dumps(payload).encode()
    return client.post(f"/hooks/{source_id}", content=body, headers={"X-Signature": sign(secret, body)})


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_unknown_source_returns_404(client):
    assert post_alert(client, "nope", load_payload("datadog"), "x").status_code == 404


def test_bad_signature_returns_401(client):
    assert post_alert(client, "datadog-prod", load_payload("datadog"), "wrong").status_code == 401


def test_missing_signature_returns_401(client):
    assert client.post("/hooks/datadog-prod", json=load_payload("datadog")).status_code == 401


def test_bad_payload_returns_422(client):
    r = post_alert(client, "datadog-prod", {"no": "title"}, TEST_SECRETS["SRC_DATADOG_SECRET"])
    assert r.status_code == 422


def test_signed_alert_returns_202(client):
    r = post_alert(client, "azure-prod", load_payload("azure_monitor"), TEST_SECRETS["SRC_AZURE_SECRET"])
    assert r.status_code == 202
    assert client.app.state.store.get(r.json()["investigation_id"]).status == "queued"


def test_same_alert_three_times_is_one_investigation(client):
    secret = TEST_SECRETS["SRC_DATADOG_SECRET"]
    responses = [post_alert(client, "datadog-prod", load_payload("datadog"), secret).json() for _ in range(3)]

    assert len({r["investigation_id"] for r in responses}) == 1
    assert responses[-1]["dedup_count"] == 3
    assert len(client.app.state.store.items) == 1
    assert client.app.state.store.newest_first()[0].dedup_count == 3


# ----------------------------------------------------------------------- bad requests


@pytest.mark.parametrize("body", [b"{not json", b"[1, 2, 3]", b"", b'"just a string"', b"null", b'{"title": "\xff"}'])
def test_unusable_body_with_valid_signature_returns_422(client, body):
    secret = TEST_SECRETS["SRC_DATADOG_SECRET"]
    r = client.post("/hooks/datadog-prod", content=body, headers={"X-Signature": sign(secret, body)})
    assert r.status_code == 422


def test_signature_must_match_exact_bytes(client):
    """Re-formatting the JSON (same data, different bytes) breaks the signature."""
    payload = load_payload("datadog")
    secret = TEST_SECRETS["SRC_DATADOG_SECRET"]
    signed_body = json.dumps(payload).encode()
    sent_body = json.dumps(payload, indent=2).encode()
    r = client.post("/hooks/datadog-prod", content=sent_body, headers={"X-Signature": sign(secret, signed_body)})
    assert r.status_code == 401


def test_unknown_source_checked_before_signature(client):
    r = client.post("/hooks/nope", content=b"anything")
    assert r.status_code == 404


def test_get_on_hook_not_allowed(client):
    assert client.get("/hooks/datadog-prod").status_code == 405


def test_rejected_requests_create_nothing(client):
    post_alert(client, "datadog-prod", load_payload("datadog"), "wrong")
    post_alert(client, "nope", load_payload("datadog"), "x")
    assert client.app.state.store.newest_first() == []


# ----------------------------------------------------------------------- dedup through the API


def test_same_title_from_different_sources_is_not_deduplicated(client):
    generic = {"title": "checkout-api 5xx rate above 5%", "fired_at": "2026-11-20T06:00:00Z"}
    a = post_alert(client, "inhouse-app", generic, TEST_SECRETS["SRC_GENERIC_SECRET"]).json()
    b = post_alert(client, "datadog-prod", load_payload("datadog"), TEST_SECRETS["SRC_DATADOG_SECRET"]).json()
    assert a["investigation_id"] != b["investigation_id"]


def test_dedup_window_comes_from_settings(registry):
    """The window applies once an investigation is closed; while it is open, repeats always merge."""
    def send(c):
        return post_alert(c, "datadog-prod", load_payload("datadog"), TEST_SECRETS["SRC_DATADOG_SECRET"]).json()

    for ttl, merged in [(0, False), (15, True)]:
        with make_client(registry, dedup_ttl_min=ttl) as c:
            first = send(c)
            assert send(c)["investigation_id"] == first["investigation_id"]  # open: merged
            c.app.state.store.get(first["investigation_id"]).status = "concluded"
            assert (send(c)["investigation_id"] == first["investigation_id"]) is merged


def test_in_house_alert_can_name_its_application(client):
    payload = {"title": "Job failed", "service": "billing-service", "fired_at": "2026-11-20T06:00:00Z"}
    inv_id = post_alert(client, "inhouse-app", payload, TEST_SECRETS["SRC_GENERIC_SECRET"]).json()["investigation_id"]
    assert client.app.state.store.get(inv_id).service == "billing-service"
