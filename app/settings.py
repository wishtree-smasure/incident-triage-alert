"""Settings read from environment variables / the .env file."""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=PROJECT_ROOT / ".env", extra="ignore")

    anthropic_api_key: str = ""
    llm_model: str = "claude-sonnet-4-5"
    max_tool_calls: int = 10
    max_investigation_sec: int = 180
    dedup_ttl_min: int = 15
    teams_webhook_url: str = ""
    app_base_url: str = "http://localhost:8000"
    # Where alerts and API calls are saved (see app/db.py). Empty = memory only.
    database_url: str = "sqlite:///data/triage.db"
    demo_mode: bool = False  # run the sample shop + log watcher inside the app (for a deployed demo)

    sources_path: Path = PROJECT_ROOT / "config" / "sources.yaml"
    playbook_path: Path = PROJECT_ROOT / "config" / "playbook.yaml"
