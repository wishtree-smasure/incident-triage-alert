"""Send the sample incidents and warnings in fixtures/sample_alerts.json to the running app.

Usage (with the app running on localhost:8000):
    python scripts/send_samples.py
    python scripts/send_samples.py --url http://localhost:8000
"""

import argparse
import json
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # so "app" can be imported

from app.registry import load_registry  # noqa: E402
from app.security import sign  # noqa: E402
from app.settings import PROJECT_ROOT  # noqa: E402

SAMPLES_FILE = PROJECT_ROOT / "fixtures" / "sample_alerts.json"


def load_samples() -> list[dict]:
    samples = json.loads(SAMPLES_FILE.read_text())
    for sample in samples:
        payload = sample["payload"]
        # SNS sends the CloudWatch alarm as a JSON *string*; the file keeps it readable as an object.
        if isinstance(payload.get("Message"), dict):
            payload["Message"] = json.dumps(payload["Message"])
    return samples


def send_all(client: httpx.Client, registry) -> list[tuple[int, str]]:
    """Sign and send every sample. Returns (HTTP status, note) for each request."""
    results = []
    for sample in load_samples():
        body = json.dumps(sample["payload"]).encode()
        signature = sign(registry.secret_for(sample["source_id"]), body)
        for _ in range(sample.get("repeat", 1)):
            response = client.post(
                f"/hooks/{sample['source_id']}",
                content=body,
                headers={"X-Signature": signature, "Content-Type": "application/json"},
            )
            results.append((response.status_code, sample["note"]))
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default="http://localhost:8000")
    args = parser.parse_args()

    load_dotenv(PROJECT_ROOT / ".env")
    registry = load_registry(PROJECT_ROOT / "config" / "sources.yaml")

    with httpx.Client(base_url=args.url) as client:
        for status, note in send_all(client, registry):
            print(f"{status}  {note}")


if __name__ == "__main__":
    main()
