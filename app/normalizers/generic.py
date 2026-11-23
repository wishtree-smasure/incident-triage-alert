"""In-house app alert. Our own format, so it is already close to NormalizedAlert:
  {"title", "service", "description", "severity": "SEV1..SEV4", "fired_at": ISO-8601, "resource", "labels"}
"service" is optional (defaults to the registry's service), so one in-house source can
report for several applications.
"""

from datetime import datetime

from app.models import NormalizedAlert


def normalize(payload: dict, source) -> NormalizedAlert:
    return NormalizedAlert(
        source_id=source.id,
        source_type=source.type,
        service=payload.get("service") or source.service,
        title=payload["title"],
        description=payload.get("description", ""),
        severity_hint=payload.get("severity"),
        fired_at=datetime.fromisoformat(payload["fired_at"]),
        resource=payload.get("resource"),
        labels=payload.get("labels", {}),
        raw=payload,
    )
