"""Watch a log file and send its errors, warnings and API calls to the triage app.

Every few seconds it reads the lines added to the log since the last check.
  - ERROR / WARNING: it finds the place in the code where it broke (the last "File ...,
    line ..." in the stack trace) and sends a signed alert as the in-house app source
    ("inhouse-app"). The same bug at the same line is de-duplicated by the app.
  - Access-log lines ("GET /products 200 42ms"): sent together as one batch of API calls
    for the API analysis tab.

Usage (with the app running on localhost:8000):
    python scripts/watch_logs.py
    python scripts/watch_logs.py --log sample_app/logs/shop.log --every 5
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # so "app" can be imported

from app.registry import load_registry  # noqa: E402
from app.security import sign  # noqa: E402
from app.settings import PROJECT_ROOT  # noqa: E402

SOURCE_ID = "inhouse-app"
DEFAULT_LOG = PROJECT_ROOT / "sample_app" / "logs" / "shop.log"

# "2026-11-20T06:42:46Z ERROR shop Order 1003 failed"
ENTRY_START = re.compile(r"^(\S+Z) (INFO|WARNING|ERROR|CRITICAL) (\S+) (.*)$")
# '  File "/path/to/shop.py", line 52, in get_db_connection'
FRAME = re.compile(r'^\s*File "(.+)", line (\d+), in (.+)$')

# Access-log message: "GET /products/42 200 37ms"
ACCESS = re.compile(r"^([A-Z]+) (\S+) (\d{3}) (\d+(?:\.\d+)?)ms$")

SEVERITY = {"CRITICAL": "SEV1", "ERROR": "SEV2", "WARNING": "SEV3"}


def parse_entries(text: str) -> list[dict]:
    """Split log text into entries. Lines that don't start with a timestamp
    (the stack trace) belong to the entry above them."""
    entries = []
    for line in text.splitlines():
        match = ENTRY_START.match(line)
        if match:
            time_, level, logger, message = match.groups()
            entries.append({"time": time_, "level": level, "logger": logger, "message": message, "trace": []})
        elif entries:
            entries[-1]["trace"].append(line)
    return entries


def where_it_broke(trace: list[str]) -> dict | None:
    """The last frame of a Python stack trace is where the error was raised."""
    frames = [FRAME.match(line) for line in trace]
    frames = [f for f in frames if f]
    if not frames:
        return None
    path, line, function = frames[-1].groups()
    try:
        path = str(Path(path).relative_to(PROJECT_ROOT))
    except ValueError:
        pass
    return {"file": path, "line": line, "function": function}


def to_alert(entry: dict, service: str = "sample-shop") -> dict | None:
    """Turn one log entry into a generic-format alert, or None if it is not a problem."""
    severity = SEVERITY.get(entry["level"])
    if severity is None:
        return None

    where = where_it_broke(entry["trace"])
    if where:
        error = entry["trace"][-1].strip()  # e.g. "TypeError: 'NoneType' object is not subscriptable"
        error_type = error.split(":")[0]
        title = f"{error_type} in {where['function']}()"
        resource = f"{where['file']}:{where['line']}"
        labels = {**where, "error_type": error_type, "logger": entry["logger"]}
    else:
        # No stack trace (e.g. a warning): use the message without its numbers, so repeats match.
        error = entry["message"]
        title = re.sub(r"\d+", "N", entry["message"])
        resource = entry["logger"]
        labels = {"logger": entry["logger"]}

    description = "\n".join([entry["message"], *entry["trace"]])
    return {
        "title": title,
        "service": service,
        "description": description[:4000],
        "severity": severity,
        "fired_at": entry["time"],
        "resource": resource,
        "labels": {**labels, "error": error[:300]},
    }


def to_api_call(entry: dict, service: str = "sample-shop") -> dict | None:
    """Turn an access-log entry ("GET /products 200 42ms") into an API-call record, else None."""
    if not entry["logger"].endswith("access"):
        return None
    match = ACCESS.match(entry["message"])
    if not match:
        return None
    method, path, status, duration_ms = match.groups()
    return {"app": service, "method": method, "path": path, "status": int(status),
            "duration_ms": float(duration_ms), "time": entry["time"]}


class LogTail:
    """Reads only what was added to a log file since the last read."""

    def __init__(self, path: Path):
        self.path = path
        self.position = 0  # how many bytes we have already read
        self.leftover = ""  # a half-written last line waits for the next read

    def new_entries(self) -> list[dict]:
        if not self.path.exists():
            return []
        if self.path.stat().st_size < self.position:  # the file was recreated: start again
            self.position, self.leftover = 0, ""
        with self.path.open() as f:
            f.seek(self.position)
            text = self.leftover + f.read()
            self.position = f.tell()
        complete, _, self.leftover = text.rpartition("\n")
        return parse_entries(complete)


def post_signed(client: httpx.Client, secret: str, path: str, payload: dict) -> int | str:
    """POST JSON signed with the source's secret. Returns the HTTP status, or why it was not sent."""
    body = json.dumps(payload).encode()
    try:
        response = client.post(
            path, content=body, headers={"X-Signature": sign(secret, body), "Content-Type": "application/json"}
        )
    except httpx.HTTPError as exc:
        return f"not sent ({exc.__class__.__name__})"
    return response.status_code


def check_once(tail: LogTail, client: httpx.Client, secret: str, service: str) -> list[str]:
    """Send every new error / warning as an alert, and all new API calls as one batch.
    Returns one result line per alert, plus one for the API calls."""
    results = []
    api_calls = []
    for entry in tail.new_entries():
        call = to_api_call(entry, service)
        if call:
            api_calls.append(call)
            continue
        alert = to_alert(entry, service)
        if alert:
            status = post_signed(client, secret, f"/hooks/{SOURCE_ID}", alert)
            results.append(f"{status}  {entry['level']:<7} {alert['title']}  @ {alert['resource']}")

    for i in range(0, len(api_calls), 5000):
        batch = api_calls[i:i + 5000]
        status = post_signed(client, secret, f"/requests/{SOURCE_ID}", {"calls": batch})
        results.append(f"{status}  API     {len(batch)} API calls")
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="Send log errors, warnings and API calls to the triage app.")
    parser.add_argument("--log", type=Path, default=DEFAULT_LOG)
    parser.add_argument("--url", default="http://localhost:8000")
    parser.add_argument("--every", type=float, default=5, help="seconds between checks")
    parser.add_argument("--service", default="sample-shop", help="application name shown on the dashboard")
    args = parser.parse_args()

    load_dotenv(PROJECT_ROOT / ".env")
    secret = load_registry(PROJECT_ROOT / "config" / "sources.yaml").secret_for(SOURCE_ID)

    print(f"Watching {args.log} every {args.every:g}s (Ctrl+C to stop)")
    tail = LogTail(args.log)
    with httpx.Client(base_url=args.url) as client:
        while True:
            for line in check_once(tail, client, secret, args.service):
                print(line, flush=True)
            time.sleep(args.every)


if __name__ == "__main__":
    main()
