"""Record what the Python app does, so the Node.js port can be tested against it.

The Python app is no longer in the repository. To record again, from a checkout of the tag:
    git worktree add ../python-final python-final && cd ../python-final
    pip install -e . && python /path/to/node/test/golden/make_goldens.py

Writes, next to this file:
  normalized.json   every sample / test payload -> normalized alert, fingerprint, suggestion
  locations.json    stack traces -> code location
  analysis.json     API analysis of fixtures/traffic_24h.json (with the sample alerts open)
and the frozen traffic set fixtures/traffic_24h.json in the current folder (generated once, used by both versions;
copy it to this repository's fixtures/ if it is regenerated).
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path.cwd()  # the python-final checkout (has app/ and scripts/)
sys.path.insert(0, str(ROOT))

from app.analysis import analyze_app, overview_of_apps  # noqa: E402
from app.dedup import fingerprint  # noqa: E402
from app.location import code_location  # noqa: E402
from app.models import ApiCall, Investigation, NormalizedAlert  # noqa: E402
from app.normalizers import normalize  # noqa: E402
from app.playbook import load_playbook, suggest  # noqa: E402
from app.registry import load_registry  # noqa: E402
from scripts import generate_traffic  # noqa: E402
from scripts.send_samples import load_samples  # noqa: E402

OUT = Path(__file__).parent
SECRETS = {"SRC_DATADOG_SECRET": "x", "SRC_CLOUDWATCH_SECRET": "x", "SRC_AZURE_SECRET": "x", "SRC_GENERIC_SECRET": "x"}
PAYLOAD_SOURCES = {"datadog": "datadog-prod", "cloudwatch_sns": "cloudwatch-prod",
                   "azure_monitor": "azure-prod", "generic": "inhouse-app"}

registry = load_registry(ROOT / "config" / "sources.yaml", env=SECRETS)
playbook = load_playbook(ROOT / "config" / "playbook.yaml")


def dump(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=1, sort_keys=True) + "\n")


# ---------------------------------------------------------------- normalized alerts
cases = [{"name": f"payload:{name}", "source_id": source_id,
          "payload": json.loads((ROOT / "tests" / "payloads" / f"{name}.json").read_text())}
         for name, source_id in PAYLOAD_SOURCES.items()]
cases += [{"name": f"sample:{i}:{s['note']}", "source_id": s["source_id"], "payload": s["payload"]}
          for i, s in enumerate(load_samples())]
normalized = []
for case in cases:
    alert = normalize(registry.get(case["source_id"]), case["payload"])
    s = suggest(alert, playbook)
    normalized.append({
        **case,
        "alert": alert.model_dump(mode="json", exclude={"raw"}),
        "fingerprint": fingerprint(alert),
        "suggestion": s.model_dump() if s else None,
        "code_location": code_location(alert),
    })
dump(OUT / "normalized.json", normalized)

# ---------------------------------------------------------------- code locations
traces = [
    "412 errors in 10 min: NullPointerException at com.shop.payment.PaymentClient.authorize(PaymentClient.java:88)",
    "java.lang.NullPointerException\n        at java.util.Objects.requireNonNull(Objects.java:209)\n"
    "        at com.shop.orders.OrderService.place(OrderService.java:41)\n"
    "        at org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:883)",
    'Traceback (most recent call last):\n  File "/srv/app/orders/views.py", line 12, in create\n'
    '    total = pricing.total(order)\n  File "/srv/app/orders/pricing.py", line 52, in total\n'
    '    return order["coupon"]["percent"]\n  File "/usr/lib/python3.12/site-packages/x/y.py", line 3, in z\n'
    "TypeError: 'NoneType' object is not subscriptable",
    "System.NullReferenceException\n   at Shop.Orders.OrderService.Create(Order o) in C:\\src\\Shop\\Orders\\OrderService.cs:line 42",
    "TypeError: Cannot read properties of undefined (reading 'id')\n"
    "    at Object.get (/srv/app/node_modules/lodash/get.js:10:3)\n"
    "    at createOrder (/srv/app/src/orders/service.ts:31:7)",
    "panic: runtime error\n\t/srv/app/orders/handler.go:42 +0x1d",
    "CPU above 90% on i-0abc for 5 minutes",
    "at /srv/app/server.js:5:1",
    "error in lib/billing/invoice.rb:17 while rendering",
]
when = datetime(2026, 11, 24, tzinfo=timezone.utc)
locations = []
for text in traces:
    alert = NormalizedAlert(source_id="s", source_type="generic", service="svc", title="Something broke",
                            description=text, fired_at=when)
    locations.append({"description": text, "location": code_location(alert)})
labelled = NormalizedAlert(source_id="s", source_type="generic", service="svc", title="x", fired_at=when,
                           labels={"file": "sample_app/shop.py", "line": "52", "function": "apply_coupon"})
locations.append({"description": "", "labels": labelled.labels, "location": code_location(labelled)})
dump(OUT / "locations.json", locations)

# ---------------------------------------------------------------- API analysis on a frozen traffic set
traffic_file = ROOT / "fixtures" / "traffic_24h.json"
if not traffic_file.exists():
    now = datetime(2026, 11, 24, 12, 0, tzinfo=timezone.utc)
    traffic_file.write_text(json.dumps(generate_traffic.generate(now, hours=24, scale=0.05, seed=3)) + "\n")
calls = [ApiCall(**c) for c in json.loads(traffic_file.read_text())]

alerts = []
for i, n in enumerate(normalized):
    alert = NormalizedAlert(**{**n["alert"], "raw": {}})
    alerts.append(Investigation(id=f"inv{i}", source_id=n["source_id"], service=alert.service, alert=alert))
by_app = {}
for c in calls:
    by_app.setdefault(c.app, []).append(c)
dump(OUT / "analysis.json", {
    "alerts": [{"id": a.id, "service": a.service, "severity": a.severity} for a in alerts],
    "overview": overview_of_apps(by_app, alerts),
    "apps": {app: analyze_app(app, app_calls, alerts) for app, app_calls in sorted(by_app.items())},
})
print(f"{len(normalized)} alerts, {len(locations)} locations, {len(calls)} API calls, {len(by_app)} apps")
