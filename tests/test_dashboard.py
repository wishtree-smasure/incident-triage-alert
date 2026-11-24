import json
import re

import pytest

from app.security import sign
from scripts.send_samples import load_samples
from tests.conftest import TEST_SECRETS, make_client


@pytest.fixture
def client(registry):
    """App loaded with all the sample alerts (several apps, all four sources)."""
    with make_client(registry) as c:
        for sample in load_samples():
            source = registry.get(sample["source_id"])
            body = json.dumps(sample["payload"]).encode()
            headers = {"X-Signature": sign(TEST_SECRETS[source.secret_env], body)}
            c.post(f"/hooks/{source.id}", content=body, headers=headers)
        yield c


def table_titles(page: str) -> list[str]:
    """Alert titles in the alert list, in display order."""
    alert_list = page.split('id="alert-list"', 1)[1]
    return re.findall(r'class="item-title">([^<]+)</span>', alert_list)


def test_empty_dashboard(registry):
    with make_client(registry) as c:
        page = c.get("/").text
    assert "Nothing here yet" in page
    assert "Show stoppers ·" not in page


def test_show_stoppers_on_top_with_immediate_action(client):
    page = client.get("/").text
    stoppers = page.split("Show stoppers ·", 1)[1].split('class="filter-row"', 1)[0]
    assert "auth-gateway 401/403 rate high" in stoppers
    assert "NullPointerException" in stoppers
    assert "Immediate action:" in stoppers
    assert "Restore the removed role assignment" in stoppers
    assert "5xx rate" not in stoppers  # SEV2 is not a show stopper


def test_applications_listed(client):
    page = client.get("/").text
    apps = page.split('name="app"', 1)[1].split("</select>", 1)[0]
    for name in ["checkout-api", "orders-service", "auth-gateway", "billing-service", "reporting-service"]:
        assert name in apps


def test_source_tabs_use_display_names(client):
    page = client.get("/").text
    for name in ["Azure prod", "AWS prod", "Datadog prod", "In-house logs"]:
        assert name in page


def test_alerts_sorted_by_priority(client):
    page = client.get("/").text
    labels = re.findall(r'<h3 class="group[^"]*">([^<]+?) <span', page)
    assert labels == [
        "SEV1 · Show stopper", "SEV2 · High", "Unrated · needs triage", "SEV3 · Medium", "SEV4 · Low",
    ]
    titles = table_titles(page)
    assert titles.index("auth-gateway 401/403 rate high") < titles.index("Disk usage above 85% on report-worker")


def test_filter_by_application(client):
    titles = table_titles(client.get("/?app=auth-gateway").text)
    assert titles and all("auth-gateway" in t for t in titles)


def test_filter_by_source(client):
    titles = table_titles(client.get("/?source=cloudwatch-prod").text)
    assert set(titles) == {"orders-service-p99-latency", "orders-db-connections-max"}


def test_filter_by_level_keeps_other_filters(client):
    page = client.get("/?app=auth-gateway&level=warning").text
    titles = table_titles(page)
    assert titles and "auth-gateway 401/403 rate high" not in titles
    assert '<option value="auth-gateway" selected>' in page
    assert re.search(r'name="level" value="warning" form="filters" checked', page)


# ----------------------------------------------------------------------- safety and edge cases


def send_generic(client, **payload):
    from tests.conftest import post_signed

    body = {"fired_at": "2026-11-20T06:00:00Z", **payload}
    return post_signed(client, "inhouse-app", body).json()["investigation_id"]


def test_html_in_alert_is_escaped(registry):
    """Alert text comes from outside: it must never run as HTML/JS on the page."""
    with make_client(registry) as c:
        inv_id = send_generic(c, title="<script>alert(1)</script>", severity="SEV1",
                              description="<img src=x onerror=alert(2)>", service="<b>app</b>")
        for page in (c.get("/").text, c.get(f"/investigations/{inv_id}").text):
            assert "<script>alert(1)</script>" not in page
            assert "&lt;script&gt;" in page
            assert "<img src=x" not in page
            assert "<b>app</b>" not in page


def test_unknown_filters_show_empty_state(client):
    assert "No alerts match these filters" in client.get("/?app=no-such-app").text
    assert "No alerts match these filters" in client.get("/?source=no-such-source").text


def test_invalid_level_is_ignored(client):
    assert table_titles(client.get("/?level=bogus").text) == table_titles(client.get("/").text)


def test_show_stoppers_stay_visible_when_filtering_another_app(client):
    page = client.get("/?app=reporting-service").text
    assert "Show stoppers ·" in page and "auth-gateway 401/403 rate high" in page


def test_app_names_are_escaped_in_filters(registry):
    with make_client(registry) as c:
        send_generic(c, title="x", service="team a&b")
        page = c.get("/").text
        assert '<option value="team a&amp;b"' in page
        assert table_titles(c.get("/?app=team a&b".replace("&", "%26")).text) == ["x"]


def test_counts_follow_the_selected_app(client):
    page = client.get("/?app=orders-service").text
    assert "Showing 2 alerts" in page
    assert re.search(r"<span>All <b>2</b></span>", page)


def test_detail_page_shows_ai_verdict_instead_of_playbook(client):
    from app.models import Verdict

    inv = client.app.state.store.newest_first()[0]
    inv.status = "concluded"
    inv.verdict = Verdict(
        investigation_id=inv.id, status="concluded", severity="SEV2", category="deployment",
        summary="Deploy broke checkout.", root_cause="Deploy v2.14.0 introduced a null pointer.",
        confidence="high", evidence=[{"claim": "NPE starts at deploy time", "tool_call_id": "tc_3"}],
        next_checks=["Roll back to v2.13.2"], ruled_out=["Database is healthy"],
    )
    page = client.get(f"/investigations/{inv.id}").text
    assert "Deploy v2.14.0 introduced a null pointer." in page
    assert "tc_3" in page and "Roll back to v2.13.2" in page and "Database is healthy" in page
    assert "Proper fix:" not in page  # the verdict replaces the playbook suggestion
    assert 'http-equiv="refresh"' not in page  # finished: no more auto-refresh


def test_detail_page_auto_refreshes_while_queued(client):
    inv = client.app.state.store.newest_first()[0]
    assert 'http-equiv="refresh" content="5"' in client.get(f"/investigations/{inv.id}").text


def test_alert_without_playbook_match(registry):
    with make_client(registry) as c:
        inv_id = send_generic(c, title="Something nobody has seen before")
        assert "No suggestion" in c.get("/").text
        assert "No playbook rule matches" in c.get(f"/investigations/{inv_id}").text


def test_show_stopper_without_playbook_match_says_page_owner(registry):
    with make_client(registry) as c:
        send_generic(c, title="Mystery outage", severity="SEV1", service="mystery-app")
        assert "page the mystery-app on-call owner" in c.get("/").text


def test_search_matches_title_app_and_file(client):
    assert table_titles(client.get("/?q=401/403").text) == ["auth-gateway 401/403 rate high"]
    titles = table_titles(client.get("/?q=ORDERS-SERVICE").text)  # case-insensitive, matches the app
    assert set(titles) >= {"orders-service-p99-latency", "orders-db-connections-max"}
    assert "No alerts match these filters" in client.get("/?q=zzz-nothing").text


def test_partial_returns_only_the_live_part(client):
    page = client.get("/?app=auth-gateway&partial=1").text
    assert page.lstrip().startswith("<div id=\"alerts-live\"")
    assert "<html" not in page and "Show stoppers ·" in page
    assert table_titles(page) and all("auth-gateway" in t for t in table_titles(page))


def test_alerts_view_updates_itself_without_meta_refresh(client):
    page = client.get("/").text
    assert 'id="live-region"' in page and "refresh(false)" in page
    assert '<noscript><meta http-equiv="refresh" content="10"></noscript>' in page
