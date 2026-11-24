"""Saved data survives a restart: alerts, repeat counts, API calls and de-duplication."""

import os
from datetime import datetime, timezone

import pytest

from app.db import Database
from app.dedup import DedupCache
from app.models import ApiCall
from app.settings import PROJECT_ROOT, Settings
from tests.conftest import make_client, post_signed

ALERT = {"title": "Disk full", "service": "billing-service", "severity": "SEV2", "fired_at": "2026-11-20T06:00:00Z"}




@pytest.fixture(params=["sqlite", "postgres"])
def db_url(request, tmp_path):
    if request.param == "sqlite":
        return f"sqlite:///{tmp_path / 'triage.db'}"
    url = os.environ.get("TEST_POSTGRES_URL")
    if not url:
        pytest.skip("set TEST_POSTGRES_URL to also test Postgres")
    db = Database(url, PROJECT_ROOT)
    with db.connect() as conn:
        for table in ("investigations", "api_calls", "dedup"):
            conn.execute(f"DELETE FROM {table}")
    return url


def test_alerts_and_api_calls_survive_a_restart(registry, db_url):
    with make_client(registry, database_url=db_url) as c:
        first = post_signed(c, "inhouse-app", ALERT).json()
        post_signed(c, "inhouse-app", ALERT)  # a repeat
        call = {"app": "billing-service", "method": "GET", "path": "/plans", "status": 200,
                "duration_ms": 12.5, "time": "2026-11-20T06:00:00Z"}
        post_signed(c, "inhouse-app", {"calls": [call]}, endpoint="requests")

    with make_client(registry, database_url=db_url) as c:  # "redeploy"
        inv = c.app.state.store.get(first["investigation_id"])
        assert inv is not None and inv.alert.title == "Disk full" and inv.dedup_count == 2
        assert c.app.state.traffic.apps() == ["billing-service"]
        assert "Disk full" in c.get("/").text
        # The same alert after the restart is still merged into the saved one.
        again = post_signed(c, "inhouse-app", ALERT).json()
        assert again["investigation_id"] == first["investigation_id"] and again["dedup_count"] == 3


def test_only_the_newest_api_calls_are_kept(db_url):
    db = Database(db_url, PROJECT_ROOT)
    t = datetime(2026, 11, 20, tzinfo=timezone.utc)
    calls = [ApiCall(app="a", method="GET", path=f"/{n}", status=200, duration_ms=1, time=t) for n in range(10)]
    db.add_calls(calls[:6], keep=4)
    db.add_calls(calls[6:], keep=4)
    assert [c.path for c in db.load_calls(100)] == ["/6", "/7", "/8", "/9"]


def test_expired_dedup_entries_are_not_loaded(db_url):
    db = Database(db_url, PROJECT_ROOT)
    now = 1_000_000.0
    DedupCache(ttl_minutes=15, clock=lambda: now, db=db).check("fp", "inv1")
    assert "fp" in DedupCache(ttl_minutes=15, clock=lambda: now + 60, db=db).entries
    assert DedupCache(ttl_minutes=15, clock=lambda: now + 16 * 60, db=db).entries == {}


def test_default_database_is_a_local_file(monkeypatch):
    monkeypatch.delenv("DATABASE_URL")
    assert Settings(_env_file=None).database_url == "sqlite:///data/triage.db"


def test_bad_database_url_stops_startup():
    with pytest.raises(ValueError, match="DATABASE_URL"):
        Database("mysql://x", PROJECT_ROOT)
