"""Suggested fixes from config/playbook.yaml: the first rule whose pattern matches the alert wins."""

import re
from pathlib import Path

import yaml
from pydantic import BaseModel

from app.models import NormalizedAlert, Suggestion


class Rule(BaseModel):
    match: str
    cause: str
    immediate: str = ""
    fix: str


def load_playbook(path: Path) -> list[Rule]:
    data = yaml.safe_load(Path(path).read_text())
    rules = [Rule(**rule) for rule in data["rules"]]
    for rule in rules:
        re.compile(rule.match)  # a broken pattern fails at startup, not on the first alert
    return rules


def suggest(alert: NormalizedAlert, rules: list[Rule]) -> Suggestion | None:
    text = "\n".join([alert.title, alert.labels.get("error", ""), alert.description])
    for rule in rules:
        if re.search(rule.match, text, re.IGNORECASE):
            return Suggestion(cause=rule.cause, immediate=rule.immediate or rule.fix, fix=rule.fix)
    return None
