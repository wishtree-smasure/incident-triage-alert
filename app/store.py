"""Keeps the last 50 investigations in memory for the demo UI. Nothing is saved to disk."""

from app.models import Investigation

MAX_ITEMS = 50


class InvestigationStore:
    def __init__(self):
        self.items: dict[str, Investigation] = {}  # dicts keep insertion order

    def add(self, investigation: Investigation) -> None:
        self.items[investigation.id] = investigation
        if len(self.items) > MAX_ITEMS:
            oldest_id = next(iter(self.items))
            del self.items[oldest_id]

    def get(self, investigation_id: str) -> Investigation | None:
        return self.items.get(investigation_id)

    def newest_first(self) -> list[Investigation]:
        return list(reversed(self.items.values()))
