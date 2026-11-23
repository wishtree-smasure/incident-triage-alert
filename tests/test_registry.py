import pytest
import yaml

from app.registry import RegistryError, load_registry
from tests.conftest import TEST_SECRETS

GOOD_SOURCE = {
    "id": "datadog-prod",
    "type": "datadog",
    "service": "checkout-api",
    "owner_team": "payments",
    "secret_env": "SRC_DATADOG_SECRET",
    "connector": "mock",
    "scenario": "bad_deploy_datadog",
}


def write_registry(tmp_path, *sources):
    path = tmp_path / "sources.yaml"
    path.write_text(yaml.safe_dump({"sources": list(sources)}))
    return path


def test_shipped_sources_yaml_loads(registry):
    assert set(registry.sources) == {"datadog-prod", "cloudwatch-prod", "azure-prod", "inhouse-app"}
    assert registry.get("datadog-prod").owner_team == "payments"
    assert registry.secret_for("datadog-prod") == "dd-secret"
    assert registry.get("unknown") is None


def test_unknown_type_fails(tmp_path):
    path = write_registry(tmp_path, {**GOOD_SOURCE, "type": "splunk"})
    with pytest.raises(RegistryError, match="type"):
        load_registry(path, env=TEST_SECRETS)


def test_missing_field_fails(tmp_path):
    source = {k: v for k, v in GOOD_SOURCE.items() if k != "owner_team"}
    with pytest.raises(RegistryError, match="owner_team"):
        load_registry(write_registry(tmp_path, source), env=TEST_SECRETS)


def test_mock_connector_needs_scenario(tmp_path):
    path = write_registry(tmp_path, {**GOOD_SOURCE, "scenario": None})
    with pytest.raises(RegistryError, match="scenario"):
        load_registry(path, env=TEST_SECRETS)


def test_duplicate_ids_fail(tmp_path):
    path = write_registry(tmp_path, GOOD_SOURCE, GOOD_SOURCE)
    with pytest.raises(RegistryError, match="duplicate"):
        load_registry(path, env=TEST_SECRETS)


def test_missing_secret_env_var_fails(tmp_path):
    with pytest.raises(RegistryError, match="SRC_DATADOG_SECRET"):
        load_registry(write_registry(tmp_path, GOOD_SOURCE), env={})


def test_bad_yaml_fails(tmp_path):
    path = tmp_path / "sources.yaml"
    path.write_text("sources: [unclosed")
    with pytest.raises(RegistryError):
        load_registry(path, env=TEST_SECRETS)


def test_display_name_falls_back_to_id(tmp_path):
    reg = load_registry(write_registry(tmp_path, GOOD_SOURCE), env=TEST_SECRETS)
    assert reg.name_of("datadog-prod") == "datadog-prod"
    assert reg.name_of("unknown") == "unknown"


def test_shipped_sources_have_display_names(registry):
    assert {registry.name_of(s) for s in registry.sources} == {
        "Datadog prod", "AWS prod", "Azure prod", "In-house logs"}


def test_unknown_field_is_rejected(tmp_path):
    path = write_registry(tmp_path, {**GOOD_SOURCE, "secret": "inline secrets not allowed"})
    with pytest.raises(RegistryError, match="secret"):
        load_registry(path, env=TEST_SECRETS)


def test_real_connector_does_not_need_scenario(tmp_path):
    path = write_registry(tmp_path, {**GOOD_SOURCE, "connector": "real", "scenario": None})
    assert load_registry(path, env=TEST_SECRETS).get("datadog-prod").connector == "real"


def test_missing_sources_key_fails(tmp_path):
    path = tmp_path / "sources.yaml"
    path.write_text("something_else: []\n")
    with pytest.raises(RegistryError):
        load_registry(path, env=TEST_SECRETS)
