"""Datadog monitor webhook.

Datadog lets you choose the payload. We expect this template:
  {"title": "$EVENT_TITLE", "body": "$EVENT_MSG", "date": "$DATE", "priority": "$ALERT_PRIORITY",
   "tags": "$TAGS", "alert_scope": "$ALERT_SCOPE"}
$DATE is epoch milliseconds; $TAGS is "key:value,key:value".
"""

from datetime import datetime, timezone

from app.models import NormalizedAlert

SEVERITY = {"P1": "SEV1", "P2": "SEV2", "P3": "SEV3", "P4": "SEV4", "P5": "SEV4"}


def normalize(payload: dict, source) -> NormalizedAlert:
    tags = dict(tag.split(":", 1) for tag in payload.get("tags", "").split(",") if ":" in tag)
    return NormalizedAlert(
        source_id=source.id,
        source_type=source.type,
        service=source.service,
        title=payload["title"],
        description=payload.get("body", ""),
        severity_hint=SEVERITY.get(payload.get("priority")),
        fired_at=datetime.fromtimestamp(int(payload["date"]) / 1000, tz=timezone.utc),
        resource=payload.get("alert_scope"),
        labels=tags,
        raw=payload,
    )
