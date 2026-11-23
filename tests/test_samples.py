"""Every sample in fixtures/sample_alerts.json must be accepted by the app."""

import json

from app.security import sign
from scripts.send_samples import load_samples
from tests.conftest import TEST_SECRETS, make_client


def test_all_samples_are_accepted(registry):
    with make_client(registry) as client:
        for sample in load_samples():
            source = registry.get(sample["source_id"])
            body = json.dumps(sample["payload"]).encode()
            signature = sign(TEST_SECRETS[source.secret_env], body)
            for _ in range(sample.get("repeat", 1)):
                r = client.post(f"/hooks/{source.id}", content=body, headers={"X-Signature": signature})
                assert r.status_code == 202, (sample["note"], r.text)

        investigations = client.app.state.store.newest_first()
        assert len(investigations) == len(load_samples())  # the repeated one was de-duplicated
        assert {inv.level for inv in investigations} == {"alert", "warning"}
