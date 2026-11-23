"""Data shapes used across the app."""

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

Severity = Literal["SEV1", "SEV2", "SEV3", "SEV4"]
Category = Literal[
    "deployment", "infrastructure", "database", "dependency", "security", "configuration", "unknown"
]


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class NormalizedAlert(BaseModel):
    """One alert, in the same shape no matter which vendor sent it."""

    source_id: str
    source_type: str
    service: str
    title: str
    description: str = ""
    severity_hint: Severity | None = None
    fired_at: datetime
    resource: str | None = None
    labels: dict[str, str] = {}
    raw: dict[str, Any] = {}

    @field_validator("fired_at")
    @classmethod
    def to_utc(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)


class ToolCall(BaseModel):
    """One step of the investigation trace."""

    id: str
    tool: str
    args: dict[str, Any] = {}
    result_summary: str = ""
    duration_ms: int = 0
    tokens: int = 0


class Evidence(BaseModel):
    claim: str
    tool_call_id: str
    source_link: str | None = None


class BlastRadius(BaseModel):
    services: list[str] = []
    user_impact: str = ""


class Verdict(BaseModel):
    investigation_id: str
    status: Literal["concluded", "inconclusive", "failed"]
    severity: Severity
    category: Category
    summary: str
    root_cause: str
    confidence: Literal["high", "medium", "low"]
    evidence: list[Evidence] = []
    ruled_out: list[str] = []
    blast_radius: BlastRadius = BlastRadius()
    next_checks: list[str] = []
    duration_sec: float = 0.0
    tool_calls_used: int = 0
    tokens_used: int = 0
    est_cost_usd: float = 0.0

    @model_validator(mode="after")
    def needs_evidence(self) -> "Verdict":
        if self.status == "concluded" and not self.evidence:
            raise ValueError("a concluded verdict needs at least one evidence item")
        return self


class ApiCall(BaseModel):
    """One API request an application served (from its access log)."""

    app: str
    method: str
    path: str
    status: int = Field(ge=100, le=599)
    duration_ms: float = Field(ge=0)
    time: datetime

    @field_validator("method")
    @classmethod
    def upper(cls, value: str) -> str:
        return value.upper()

    @field_validator("time")
    @classmethod
    def to_utc(cls, value: datetime) -> datetime:
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


class ApiCallBatch(BaseModel):
    calls: list[ApiCall] = Field(max_length=10_000)


class Suggestion(BaseModel):
    """A quick suggested fix from config/playbook.yaml (not checked against evidence)."""

    cause: str
    immediate: str  # stop the damage now
    fix: str  # proper fix afterwards


class Investigation(BaseModel):
    """What we keep in memory for each alert we investigate."""

    id: str
    source_id: str
    service: str
    alert: NormalizedAlert
    status: Literal["queued", "running", "concluded", "inconclusive", "failed"] = "queued"
    created_at: datetime = Field(default_factory=utcnow)
    dedup_count: int = 1
    trace: list[ToolCall] = []
    suggestion: Suggestion | None = None
    verdict: Verdict | None = None

    @property
    def severity(self) -> Severity | None:
        """The agent's verdict severity once known, otherwise what the monitoring tool sent."""
        return self.verdict.severity if self.verdict else self.alert.severity_hint

    @property
    def level(self) -> Literal["alert", "warning"]:
        """SEV3/SEV4 are warnings. Everything else, including unknown severity, is an alert."""
        return "warning" if self.severity in ("SEV3", "SEV4") else "alert"
