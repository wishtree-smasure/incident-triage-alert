"""Azure Monitor common alert schema: the fields we need live in data.essentials."""

from datetime import datetime

from app.models import NormalizedAlert

# Azure Sev0 is the most severe.
SEVERITY = {"Sev0": "SEV1", "Sev1": "SEV2", "Sev2": "SEV3", "Sev3": "SEV4", "Sev4": "SEV4"}


def normalize(payload: dict, source) -> NormalizedAlert:
    e = payload["data"]["essentials"]
    targets = e.get("alertTargetIDs") or [None]
    return NormalizedAlert(
        source_id=source.id,
        source_type=source.type,
        service=source.service,
        title=e["alertRule"],
        description=e.get("description", ""),
        severity_hint=SEVERITY.get(e.get("severity")),
        fired_at=datetime.fromisoformat(e["firedDateTime"]),
        resource=targets[0],
        labels={
            "monitor_condition": e.get("monitorCondition", ""),
            "signal_type": e.get("signalType", ""),
        },
        raw=payload,
    )
