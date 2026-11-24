"""Keeps the most recent API calls for the API analysis tab: in memory, and in the database if one is set."""

from collections import deque

from app.models import ApiCall

MAX_CALLS = 200_000  # oldest calls are dropped first


class TrafficStore:
    def __init__(self, max_calls: int = MAX_CALLS, db=None):
        self.db = db
        self.max_calls = max_calls
        self.calls: deque[ApiCall] = deque(maxlen=max_calls)
        if db:
            self.calls.extend(db.load_calls(max_calls))

    def add(self, calls: list[ApiCall]) -> None:
        self.calls.extend(calls)
        if self.db:
            self.db.add_calls(calls, keep=self.max_calls)

    def for_app(self, app: str) -> list[ApiCall]:
        return [c for c in self.calls if c.app == app]

    def apps(self) -> list[str]:
        return sorted({c.app for c in self.calls})
