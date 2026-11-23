from datetime import datetime, timezone

from app.dedup import DedupCache, fingerprint
from app.models import NormalizedAlert


def make_alert(**changes) -> NormalizedAlert:
    fields = dict(
        source_id="datadog-prod",
        source_type="datadog",
        service="checkout-api",
        title="5xx rate high",
        resource="service:checkout-api",
        description="first",
        fired_at=datetime(2026, 11, 19, 10, tzinfo=timezone.utc),
    )
    return NormalizedAlert(**{**fields, **changes})


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def test_same_alert_same_fingerprint():
    # description and time are not part of the fingerprint
    later = make_alert(description="second", fired_at=datetime(2026, 11, 19, 11, tzinfo=timezone.utc))
    assert fingerprint(make_alert()) == fingerprint(later)


def test_different_alert_different_fingerprint():
    assert fingerprint(make_alert()) != fingerprint(make_alert(title="latency high"))
    assert fingerprint(make_alert()) != fingerprint(make_alert(resource="host:web-1"))


def test_repeats_within_ttl_are_duplicates():
    cache = DedupCache(ttl_minutes=15)
    assert cache.check("fp", "inv-1") == ("inv-1", 1, False)
    assert cache.check("fp", "inv-2") == ("inv-1", 2, True)
    assert cache.check("fp", "inv-3") == ("inv-1", 3, True)


def test_after_ttl_a_new_investigation_starts():
    clock = FakeClock()
    cache = DedupCache(ttl_minutes=15, clock=clock)
    cache.check("fp", "inv-1")
    clock.now = 15 * 60
    assert cache.check("fp", "inv-2") == ("inv-2", 1, False)
