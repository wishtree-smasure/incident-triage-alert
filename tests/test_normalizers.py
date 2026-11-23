import json
from datetime import datetime, timezone

import pytest

from app.normalizers import NormalizationError, normalize
from tests.conftest import load_payload


def test_datadog(registry):
    alert = normalize(registry.get("datadog-prod"), load_payload("datadog"))
    assert alert.service == "checkout-api"
    assert "5xx rate above 5%" in alert.title
    assert alert.severity_hint == "SEV2"  # P2
    assert alert.fired_at == datetime.fromtimestamp(1795082400, tz=timezone.utc)
    assert alert.labels["env"] == "prod"


def test_cloudwatch(registry):
    alert = normalize(registry.get("cloudwatch-prod"), load_payload("cloudwatch_sns"))
    assert alert.service == "orders-service"
    assert alert.title == "orders-service-p99-latency"
    assert alert.severity_hint is None  # CloudWatch has no severity
    assert alert.fired_at == datetime(2026, 11, 19, 10, 0, tzinfo=timezone.utc)
    assert alert.resource == "LoadBalancer=app/orders-alb/50dc6c495c0c9188"


def test_azure_monitor(registry):
    alert = normalize(registry.get("azure-prod"), load_payload("azure_monitor"))
    assert alert.service == "auth-gateway"
    assert alert.title == "auth-gateway 401/403 rate high"
    assert alert.severity_hint == "SEV2"  # Azure Sev1
    assert alert.fired_at == datetime(2026, 11, 19, 9, 30, 12, 345000, tzinfo=timezone.utc)
    assert alert.resource.endswith("/components/auth-gateway")


def test_generic(registry):
    alert = normalize(registry.get("inhouse-app"), load_payload("generic"))
    assert alert.title == "Invoice job failures"
    assert alert.severity_hint == "SEV2"
    assert alert.labels == {"env": "prod", "region": "eu-west-1"}


def test_raw_payload_is_kept(registry):
    payload = load_payload("datadog")
    assert normalize(registry.get("datadog-prod"), payload).raw == payload


@pytest.mark.parametrize("source_id", ["datadog-prod", "cloudwatch-prod", "azure-prod", "inhouse-app"])
def test_wrong_payload_shape_raises(registry, source_id):
    with pytest.raises(NormalizationError):
        normalize(registry.get(source_id), {"unexpected": "shape"})


def test_azure_without_targets_has_no_resource(registry):
    payload = load_payload("azure_monitor")
    payload["data"]["essentials"]["alertTargetIDs"] = []
    assert normalize(registry.get("azure-prod"), payload).resource is None


def test_cloudwatch_without_dimensions_uses_alarm_arn(registry):
    payload = load_payload("cloudwatch_sns")
    alarm = json.loads(payload["Message"])
    alarm["Trigger"]["Dimensions"] = []
    payload["Message"] = json.dumps(alarm)
    assert normalize(registry.get("cloudwatch-prod"), payload).resource == alarm["AlarmArn"]


def test_cloudwatch_message_not_json_raises(registry):
    payload = load_payload("cloudwatch_sns")
    payload["Message"] = "{not json"
    with pytest.raises(NormalizationError):
        normalize(registry.get("cloudwatch-prod"), payload)


def test_datadog_without_tags(registry):
    payload = load_payload("datadog")
    del payload["tags"]
    assert normalize(registry.get("datadog-prod"), payload).labels == {}


def test_generic_service_defaults_to_registry_and_can_be_overridden(registry):
    base = {"title": "x", "fired_at": "2026-11-20T06:00:00Z"}
    assert normalize(registry.get("inhouse-app"), base).service == "inhouse-app"
    assert normalize(registry.get("inhouse-app"), {**base, "service": "billing"}).service == "billing"


def test_generic_rejects_unknown_severity(registry):
    with pytest.raises(NormalizationError):
        normalize(registry.get("inhouse-app"), {"title": "x", "fired_at": "2026-11-20T06:00:00Z", "severity": "urgent"})


@pytest.mark.parametrize("source_id", ["datadog-prod", "cloudwatch-prod", "azure-prod", "inhouse-app"])
@pytest.mark.parametrize("payload", [[], "text", None, 42])
def test_non_object_payload_raises(registry, source_id, payload):
    with pytest.raises(NormalizationError):
        normalize(registry.get(source_id), payload)
