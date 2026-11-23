"""Keeps the most recent API calls in memory for the API analysis tab. Nothing is saved to disk."""

from collections import deque

from app.models import ApiCall

MAX_CALLS = 200_000  # oldest calls are dropped first


class TrafficStore:
    def __init__(self, max_calls: int = MAX_CALLS):
        self.calls: deque[ApiCall] = deque(maxlen=max_calls)

    def add(self, calls: list[ApiCall]) -> None:
        self.calls.extend(calls)

    def for_app(self, app: str) -> list[ApiCall]:
        return [c for c in self.calls if c.app == app]

    def apps(self) -> list[str]:
        return sorted({c.app for c in self.calls})
