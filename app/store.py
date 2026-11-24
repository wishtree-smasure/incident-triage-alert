"""Keeps the last 200 investigations for the dashboard: in memory, and in the database if one is set."""

from app.models import Investigation

MAX_ITEMS = 200


class InvestigationStore:
    def __init__(self, db=None):
        self.db = db
        self.items: dict[str, Investigation] = {}  # dicts keep insertion order
        if db:
            for inv in db.load_investigations(MAX_ITEMS):
                self.items[inv.id] = inv

    def add(self, investigation: Investigation) -> None:
        self.items[investigation.id] = investigation
        self.save(investigation)
        if len(self.items) > MAX_ITEMS:
            oldest_id = next(iter(self.items))
            del self.items[oldest_id]
            if self.db:
                self.db.delete_investigation(oldest_id)

    def save(self, investigation: Investigation) -> None:
        """Call after changing an investigation (repeat count, status, verdict) so the change is kept."""
        if self.db:
            self.db.save_investigation(investigation)

    def get(self, investigation_id: str) -> Investigation | None:
        return self.items.get(investigation_id)

    def newest_first(self) -> list[Investigation]:
        return list(reversed(self.items.values()))
