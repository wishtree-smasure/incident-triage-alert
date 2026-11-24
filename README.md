# Incident Triage Agent

Demo POC (PBI 39): receives alerts from monitoring sources (Datadog, CloudWatch, Azure Monitor, generic), verifies their HMAC signatures, de-duplicates them, runs an investigation and shows the results on a dashboard. See [REQUIREMENTS.md](REQUIREMENTS.md) for the full spec.

## Setup

Requires Python 3.11+.

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"        # or: pip install -r requirements.txt
cp .env.example .env           # then set the SRC_*_SECRET values
```

The app refuses to start if any `secret_env` listed in `config/sources.yaml` is unset.

## Run

```bash
uvicorn app.main:app --reload            # dashboard at http://localhost:8000
python scripts/send_samples.py           # send the sample alerts in fixtures/sample_alerts.json
python scripts/generate_traffic.py       # generate synthetic request traffic
python sample_app/shop.py                # sample app writing sample_app/logs/shop.log
python scripts/watch_logs.py --log sample_app/logs/shop.log --every 5
```

## Saved data

Alerts, API calls and repeat counts are saved to the database in `DATABASE_URL` and loaded
back on startup, so they survive restarts and redeploys:

- `sqlite:///data/triage.db` (default): a local file.
- `postgresql://...`: Postgres. Use this on Render, whose disk is wiped on every deploy.
- empty: memory only (what the tests use).

## Deploy on Render

Set these environment variables on the web service:

- `SRC_DATADOG_SECRET`, `SRC_CLOUDWATCH_SECRET`, `SRC_AZURE_SECRET`, `SRC_GENERIC_SECRET`
- `DATABASE_URL`: the Postgres connection string (Render Postgres "Internal Database URL", or e.g. Neon)
- `DEMO_MODE=true`: runs the sample shop and log watcher inside the app, and on the first start
  loads the sample alerts and 24 hours of API traffic for every sample application.

## Test

```bash
pytest --cov=app
```
