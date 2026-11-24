"""Builds what the dashboard shows: show stoppers, applications, source tabs and
alerts grouped by priority.
Filters: ?view=analysis&app=<service>&source=<source_id>&level=alert|warning&q=<search text>
"""

from urllib.parse import urlencode

from app.models import Investigation
from app.registry import Registry

# Highest priority first. Unknown severity (e.g. CloudWatch) sits between alerts and warnings.
PRIORITIES = [
    ("SEV1", "SEV1 · Show stopper"),
    ("SEV2", "SEV2 · High"),
    (None, "Unrated · needs triage"),
    ("SEV3", "SEV3 · Medium"),
    ("SEV4", "SEV4 · Low"),
]
RANK = {severity: rank for rank, (severity, _) in enumerate(PRIORITIES)}


def by_priority(inv: Investigation) -> tuple:
    """Sort key: highest priority first, then newest first."""
    return (RANK[inv.severity], -inv.created_at.timestamp())


def count(investigations: list[Investigation]) -> dict:
    return {
        "total": len(investigations),
        "stoppers": sum(1 for i in investigations if i.severity == "SEV1"),
        "alert": sum(1 for i in investigations if i.level == "alert"),
        "warning": sum(1 for i in investigations if i.level == "warning"),
        "duplicates": sum(i.dedup_count - 1 for i in investigations),
    }


def matches(inv: Investigation, q: str) -> bool:
    """Search: case-insensitive text match on title, application, where it broke and the description."""
    a = inv.alert
    text = " ".join(str(x) for x in (a.title, inv.service, a.resource, a.description) if x)
    return q.lower() in text.lower()


def build(
    everything: list[Investigation],
    registry: Registry,
    app: str | None,
    source: str | None,
    level: str | None,
    view: str | None = None,
    q: str | None = None,
) -> dict:
    # Show stoppers are always shown, whatever filter is selected.
    show_stoppers = sorted((i for i in everything if i.severity == "SEV1"), key=by_priority)

    # Applications: one card each, worst first.
    applications = []
    for name in {i.service for i in everything}:
        items = [i for i in everything if i.service == name]
        applications.append({"name": name, "counts": count(items), "worst": min(RANK[i.severity] for i in items)})
    applications.sort(key=lambda a: (a["worst"], a["name"]))

    in_app = [i for i in everything if app is None or i.service == app]

    # Source tabs: every registered source, with how many alerts it has for the selected app.
    sources = [
        {"id": s.id, "name": registry.name_of(s.id), "n": sum(1 for i in in_app if i.source_id == s.id)}
        for s in registry.sources.values()
    ]

    in_source = [i for i in in_app if source is None or i.source_id == source]
    q = (q or "").strip() or None
    matching = [i for i in in_source if q is None or matches(i, q)]
    shown = [i for i in matching if level is None or i.level == level]

    groups = []
    for severity, label in PRIORITIES:
        items = sorted((i for i in shown if i.severity == severity), key=by_priority)
        if items:
            groups.append({"severity": severity, "label": label, "items": items})

    def link(**changes) -> str:
        params = {"view": view, "app": app, "source": source, "level": level, "q": q, **changes}
        query = urlencode({k: v for k, v in params.items() if v})
        return f"/?{query}" if query else "/"

    return {
        "show_stoppers": show_stoppers,
        "applications": applications,
        "all_counts": count(everything),
        "sources": sources,
        "counts": count(matching),
        "shown": len(shown),
        "groups": groups,
        "q": q,
        "filtered": any((app, source, level, q)),
        "app": app,
        "source": source,
        "level": level,
        "view": view,
        "link": link,
        "source_name": registry.name_of,
    }
