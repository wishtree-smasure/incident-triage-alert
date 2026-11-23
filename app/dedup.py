"""De-duplication: the same alert within DEDUP_TTL_MIN minutes reuses the first investigation."""

import hashlib
import time

from app.models import NormalizedAlert


def fingerprint(alert: NormalizedAlert) -> str:
    key = "|".join([alert.source_id, alert.service, alert.title, alert.resource or ""])
    return hashlib.sha256(key.encode()).hexdigest()


class DedupCache:
    def __init__(self, ttl_minutes: int, clock=time.time):
        self.ttl_seconds = ttl_minutes * 60
        self.clock = clock
        self.entries = {}  # fingerprint -> {"investigation_id", "first_seen", "count"}

    def check(self, fp: str, new_investigation_id: str) -> tuple[str, int, bool]:
        """Returns (investigation_id, count, is_duplicate)."""
        now = self.clock()
        entry = self.entries.get(fp)

        if entry and now - entry["first_seen"] < self.ttl_seconds:
            entry["count"] += 1
            return entry["investigation_id"], entry["count"], True

        self.entries[fp] = {"investigation_id": new_investigation_id, "first_seen": now, "count": 1}
        return new_investigation_id, 1, False
