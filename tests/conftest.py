import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.registry import load_registry
from app.security import sign
from app.settings import PROJECT_ROOT, Settings

PAYLOADS = Path(__file__).parent / "payloads"

TEST_SECRETS = {
    "SRC_DATADOG_SECRET": "dd-secret",
    "SRC_CLOUDWATCH_SECRET": "cw-secret",
    "SRC_AZURE_SECRET": "az-secret",
    "SRC_GENERIC_SECRET": "gen-secret",
}


@pytest.fixture(autouse=True)
def memory_only(monkeypatch):
    """Tests never touch the real database file: DATABASE_URL empty = memory only.
    Tests of the database itself pass their own URL."""
    monkeypatch.setenv("DATABASE_URL", "")


def load_payload(name: str) -> dict:
    return json.loads((PAYLOADS / f"{name}.json").read_text())


@pytest.fixture
def registry():
    """The real config/sources.yaml, with test secrets."""
    return load_registry(PROJECT_ROOT / "config" / "sources.yaml", env=TEST_SECRETS)


def make_client(registry, **settings) -> TestClient:
    """A test client whose settings ignore the developer's .env file."""
    return TestClient(create_app(registry=registry, settings=Settings(_env_file=None, **settings)))


@pytest.fixture
def client(registry):
    with make_client(registry) as c:
        yield c


def post_signed(client, source_id: str, payload, secret_env: str | None = None, endpoint: str = "hooks"):
    """POST a payload to /<endpoint>/<source_id> (alerts: hooks, API calls: requests),
    signed with that source's test secret."""
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    env = secret_env or {
        "datadog-prod": "SRC_DATADOG_SECRET",
        "cloudwatch-prod": "SRC_CLOUDWATCH_SECRET",
        "azure-prod": "SRC_AZURE_SECRET",
        "inhouse-app": "SRC_GENERIC_SECRET",
    }.get(source_id, "SRC_GENERIC_SECRET")
    headers = {"X-Signature": sign(TEST_SECRETS[env], body), "Content-Type": "application/json"}
    return client.post(f"/{endpoint}/{source_id}", content=body, headers=headers)
