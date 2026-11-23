import json

import pytest

from app.normalizers import normalize
from app.playbook import Rule, load_playbook, suggest
from app.security import sign
from app.settings import PROJECT_ROOT
from scripts.send_samples import load_samples
from scripts.watch_logs import parse_entries, to_alert
from tests.conftest import TEST_SECRETS, make_client
from tests.test_watch_logs import LOG

PLAYBOOK = load_playbook(PROJECT_ROOT / "config" / "playbook.yaml")


def test_every_sample_alert_gets_a_suggestion(registry):
    for sample in load_samples():
        alert = normalize(registry.get(sample["source_id"]), sample["payload"])
        assert suggest(alert, PLAYBOOK) is not None, sample["note"]


def test_shop_coupon_bug_gets_none_check_fix(registry):
    entry = parse_entries(LOG)[1]  # TypeError: 'NoneType' object is not subscriptable
    alert = normalize(registry.get("inhouse-app"), to_alert(entry))
    assert "None" in suggest(alert, PLAYBOOK).fix


def test_first_matching_rule_wins(registry):
    rules = [Rule(match="5xx", cause="first", fix="a"), Rule(match="checkout", cause="second", fix="b")]
    alert = normalize(registry.get("datadog-prod"), load_samples()[0]["payload"])
    assert suggest(alert, rules).cause == "first"


def test_no_match_returns_none(registry):
    alert = normalize(registry.get("inhouse-app"), {"title": "something new", "fired_at": "2026-11-20T06:00:00Z"})
    assert suggest(alert, PLAYBOOK) is None


def test_broken_pattern_fails_at_load(tmp_path):
    path = tmp_path / "playbook.yaml"
    path.write_text("rules:\n  - {match: '([', cause: c, fix: f}\n")
    with pytest.raises(Exception):
        load_playbook(path)


def test_fix_is_shown_on_dashboard_and_detail_page(registry):
    secret = TEST_SECRETS["SRC_GENERIC_SECRET"]
    body = json.dumps(to_alert(parse_entries(LOG)[1])).encode()
    with make_client(registry) as client:
        inv_id = client.post(
            "/hooks/inhouse-app", content=body, headers={"X-Signature": sign(secret, body)}
        ).json()["investigation_id"]
        assert "Check for None" in client.get("/").text
        page = client.get(f"/investigations/{inv_id}").text
        assert "Likely cause:" in page and "Immediate action:" in page and "Proper fix:" in page
        assert "sample-shop" in page  # the application named by the log watcher


def make(registry, title):
    return normalize(registry.get("inhouse-app"), {"title": title, "fired_at": "2026-11-20T06:00:00Z"})


def test_matching_ignores_case(registry):
    assert suggest(make(registry, "DISK USAGE above 90%"), PLAYBOOK) is not None


def test_immediate_falls_back_to_fix(registry):
    rules = [Rule(match="boom", cause="c", fix="the fix")]
    assert suggest(make(registry, "boom"), rules).immediate == "the fix"


def test_matches_error_label_and_description(registry):
    alert = normalize(registry.get("inhouse-app"), {
        "title": "Generic title", "fired_at": "2026-11-20T06:00:00Z",
        "description": "... connection pool exhausted (20/20 in use)",
    })
    assert "database connections" in suggest(alert, PLAYBOOK).cause


def test_every_rule_has_cause_immediate_and_fix():
    for rule in PLAYBOOK:
        assert rule.cause and rule.immediate and rule.fix, rule.match


def test_rule_missing_a_field_fails_at_load(tmp_path):
    path = tmp_path / "playbook.yaml"
    path.write_text("rules:\n  - {match: 'x', cause: c}\n")
    with pytest.raises(Exception, match="fix"):
        load_playbook(path)
