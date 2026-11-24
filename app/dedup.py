"""De-duplication: a repeat of an alert is merged into the first one (its count goes up)
while that first one is still open (queued / running), or within DEDUP_TTL_MIN minutes.
Once it is closed, or no longer kept, a repeat starts a new investigation."""

import hashlib
import time

from app.models import NormalizedAlert


def fingerprint(alert: NormalizedAlert) -> str:
    key = "|".join([alert.source_id, alert.service, alert.title, alert.resource or ""])
    return hashlib.sha256(key.encode()).hexdigest()


KEEP_SECONDS = 7 * 24 * 3600  # saved entries older than a week are dropped on startup


class DedupCache:
    def __init__(self, ttl_minutes: int, clock=time.time, db=None):
        self.ttl_seconds = ttl_minutes * 60
        self.clock = clock
        self.db = db
        # fingerprint -> {"investigation_id", "first_seen", "count"}
        self.entries = db.load_dedup(newer_than=clock() - KEEP_SECONDS) if db else {}

    def check(self, fp: str, new_investigation_id: str, state_of=None) -> tuple[str, int, bool]:
        """Returns (investigation_id, count, is_duplicate).
        state_of(investigation_id) -> "open" | "closed" | None (no longer kept). Without it,
        only the time window counts."""
        now = self.clock()
        entry = self.entries.get(fp)
        state = state_of(entry["investigation_id"]) if entry and state_of else "closed"
        recent = entry is not None and now - entry["first_seen"] < self.ttl_seconds

        if entry and state is not None and (state == "open" or recent):
            entry["count"] += 1
            self._save(fp)
            return entry["investigation_id"], entry["count"], True

        self.entries[fp] = {"investigation_id": new_investigation_id, "first_seen": now, "count": 1}
        self._save(fp)
        return new_investigation_id, 1, False

    def _save(self, fp: str) -> None:
        if self.db:
            self.db.save_dedup(fp, self.entries[fp])
