"""AWS CloudWatch alarm sent through SNS.

SNS wraps the alarm: the alarm itself is a JSON *string* in the "Message" field.
CloudWatch alarms have no severity, so severity_hint stays empty.
"""

import json
from datetime import datetime

from app.models import NormalizedAlert


def normalize(payload: dict, source) -> NormalizedAlert:
    alarm = json.loads(payload["Message"])
    trigger = alarm.get("Trigger", {})
    dimensions = trigger.get("Dimensions", [])
    resource = ",".join(f"{d['name']}={d['value']}" for d in dimensions) or alarm.get("AlarmArn")
    return NormalizedAlert(
        source_id=source.id,
        source_type=source.type,
        service=source.service,
        title=alarm["AlarmName"],
        description=alarm.get("NewStateReason", ""),
        fired_at=datetime.fromisoformat(alarm["StateChangeTime"]),
        resource=resource,
        labels={
            "metric_name": trigger.get("MetricName", ""),
            "region": alarm.get("Region", ""),
        },
        raw=payload,
    )
