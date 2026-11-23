"""Source Registry: reads config/sources.yaml and checks it at startup."""

import os
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ValidationError, model_validator


class RegistryError(Exception):
    """The registry file is missing, malformed, or a secret env var is not set."""


class Source(BaseModel, extra="forbid"):
    id: str
    name: str = ""  # shown on the dashboard, e.g. "Azure prod"; defaults to the id
    type: Literal["azure_monitor", "cloudwatch", "datadog", "generic"]
    service: str
    owner_team: str
    secret_env: str
    connector: Literal["mock", "real"] = "mock"
    scenario: str | None = None

    @model_validator(mode="after")
    def mock_needs_scenario(self) -> "Source":
        if self.connector == "mock" and not self.scenario:
            raise ValueError("'scenario' is required when connector is 'mock'")
        return self


class Registry:
    def __init__(self, sources: list[Source], env: dict[str, str] | None = None):
        env = os.environ if env is None else env
        self.sources = {s.id: s for s in sources}

        if len(self.sources) != len(sources):
            raise RegistryError("sources.yaml has duplicate source ids")

        missing = [s.secret_env for s in sources if not env.get(s.secret_env)]
        if missing:
            raise RegistryError(f"missing secret env vars: {', '.join(missing)}")

        self.secrets = {s.id: env[s.secret_env] for s in sources}

    def get(self, source_id: str) -> Source | None:
        return self.sources.get(source_id)

    def name_of(self, source_id: str) -> str:
        source = self.sources.get(source_id)
        return (source.name or source.id) if source else source_id

    def secret_for(self, source_id: str) -> str:
        return self.secrets[source_id]


def load_registry(path: Path, env: dict[str, str] | None = None) -> Registry:
    try:
        data = yaml.safe_load(Path(path).read_text())
        sources = [Source(**entry) for entry in data["sources"]]
    except (OSError, yaml.YAMLError, KeyError, TypeError, ValidationError) as exc:
        raise RegistryError(f"invalid source registry {path}: {exc}") from exc
    return Registry(sources, env)
