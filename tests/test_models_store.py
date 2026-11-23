"""Schemas (alert, verdict, investigation) and the in-memory store."""

from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app.models import Investigation, NormalizedAlert, Verdict
from app.store import MAX_ITEMS, InvestigationStore


def make_alert(**changes) -> NormalizedAlert:
    fields = dict(source_id="s", source_type="generic", service="app", title="t",
                  fired_at=datetime(2026, 11, 20, 6, tzinfo=timezone.utc))
    return NormalizedAlert(**{**fields, **changes})


def make_verdict(**changes) -> dict:
    fields = dict(investigation_id="i", status="concluded", severity="SEV1", category="deployment",
                  summary="s", root_cause="r", confidence="high",
                  evidence=[{"claim": "c", "tool_call_id": "tc_1"}])
    return {**fields, **changes}


# ----------------------------------------------------------------------- alert


def test_time_without_timezone_is_treated_as_utc():
    assert make_alert(fired_at=datetime(2026, 11, 20, 6)).fired_at.tzinfo == timezone.utc


def test_other_timezones_are_converted_to_utc():
    ist = timezone(timedelta(hours=5, minutes=30))
    alert = make_alert(fired_at=datetime(2026, 11, 20, 11, 30, tzinfo=ist))
    assert alert.fired_at == datetime(2026, 11, 20, 6, 0, tzinfo=timezone.utc)


def test_invalid_severity_hint_rejected():
    with pytest.raises(ValidationError):
        make_alert(severity_hint="SEV9")


# ----------------------------------------------------------------------- verdict


def test_valid_verdict():
    assert Verdict(**make_verdict()).evidence[0].tool_call_id == "tc_1"


def test_concluded_verdict_needs_evidence():
    with pytest.raises(ValidationError, match="evidence"):
        Verdict(**make_verdict(evidence=[]))


@pytest.mark.parametrize("status", ["inconclusive", "failed"])
def test_unfinished_verdict_may_have_no_evidence(status):
    assert Verdict(**make_verdict(status=status, evidence=[])).status == status


@pytest.mark.parametrize("field, value", [("severity", "SEV0"), ("category", "network"),
                                          ("confidence", "certain"), ("status", "done")])
def test_verdict_rejects_unknown_values(field, value):
    with pytest.raises(ValidationError):
        Verdict(**make_verdict(**{field: value}))


# ----------------------------------------------------------------------- investigation severity / level


@pytest.mark.parametrize("hint, level", [("SEV1", "alert"), ("SEV2", "alert"), (None, "alert"),
                                         ("SEV3", "warning"), ("SEV4", "warning")])
def test_level_from_severity(hint, level):
    inv = Investigation(id="i", source_id="s", service="app", alert=make_alert(severity_hint=hint))
    assert inv.level == level


def test_verdict_severity_overrides_monitoring_tool():
    inv = Investigation(id="i", source_id="s", service="app", alert=make_alert(severity_hint="SEV4"))
    inv.verdict = Verdict(**make_verdict(severity="SEV1"))
    assert inv.severity == "SEV1" and inv.level == "alert"


# ----------------------------------------------------------------------- store


def make_investigation(n: int) -> Investigation:
    return Investigation(id=f"inv-{n}", source_id="s", service="app", alert=make_alert())


def test_store_get_and_order():
    store = InvestigationStore()
    for n in range(3):
        store.add(make_investigation(n))
    assert store.get("inv-1").id == "inv-1"
    assert store.get("missing") is None
    assert [i.id for i in store.newest_first()] == ["inv-2", "inv-1", "inv-0"]


def test_store_keeps_only_the_newest_50():
    store = InvestigationStore()
    for n in range(MAX_ITEMS + 5):
        store.add(make_investigation(n))
    assert len(store.items) == MAX_ITEMS
    assert store.get("inv-0") is None  # oldest dropped
    assert store.get(f"inv-{MAX_ITEMS + 4}") is not None
