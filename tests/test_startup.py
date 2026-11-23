"""The app refuses to start with bad configuration, and settings come from the environment."""

import pytest
import yaml
from fastapi.testclient import TestClient

from app.main import create_app
from app.registry import RegistryError
from app.settings import PROJECT_ROOT, Settings


def write_sources(tmp_path, secret_env):
    path = tmp_path / "sources.yaml"
    source = {"id": "s", "type": "generic", "service": "x", "owner_team": "t",
              "secret_env": secret_env, "scenario": "demo"}
    path.write_text(yaml.safe_dump({"sources": [source]}))
    return path


def test_missing_secret_stops_startup(tmp_path, monkeypatch):
    monkeypatch.delenv("SRC_TEST_NOT_SET", raising=False)
    settings = Settings(_env_file=None, sources_path=write_sources(tmp_path, "SRC_TEST_NOT_SET"))
    with pytest.raises(RegistryError, match="SRC_TEST_NOT_SET"):
        with TestClient(create_app(settings=settings)):
            pass


def test_starts_with_registry_from_settings(tmp_path, monkeypatch):
    monkeypatch.setenv("SRC_TEST_SET", "secret")
    settings = Settings(_env_file=None, sources_path=write_sources(tmp_path, "SRC_TEST_SET"))
    with TestClient(create_app(settings=settings)) as c:
        assert c.get("/health").json() == {"status": "ok"}
        assert c.app.state.registry.get("s") is not None


def test_broken_playbook_stops_startup(tmp_path, monkeypatch):
    monkeypatch.setenv("SRC_TEST_SET", "secret")
    playbook = tmp_path / "playbook.yaml"
    playbook.write_text("rules:\n  - {match: '([', cause: c, fix: f}\n")
    settings = Settings(_env_file=None, sources_path=write_sources(tmp_path, "SRC_TEST_SET"), playbook_path=playbook)
    with pytest.raises(Exception):
        with TestClient(create_app(settings=settings)):
            pass


def test_settings_defaults():
    s = Settings(_env_file=None)
    assert (s.max_tool_calls, s.max_investigation_sec, s.dedup_ttl_min) == (10, 180, 15)
    assert s.sources_path == PROJECT_ROOT / "config" / "sources.yaml"


def test_settings_read_from_environment(monkeypatch):
    monkeypatch.setenv("DEDUP_TTL_MIN", "3")
    monkeypatch.setenv("MAX_TOOL_CALLS", "2")
    s = Settings(_env_file=None)
    assert s.dedup_ttl_min == 3 and s.max_tool_calls == 2
