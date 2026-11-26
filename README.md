# Incident Triage Agent

Demo POC (PBI 39): receives alerts from monitoring sources (Datadog, CloudWatch, Azure Monitor, generic), verifies their HMAC signatures, de-duplicates them, runs an investigation and shows the results on a dashboard. See [REQUIREMENTS.md](REQUIREMENTS.md) for the full spec.

## Setup

The app is Node.js + TypeScript, in [node/](node/). Requires Node.js 20+ (22 recommended) and, for the demo's
sample shop only, Python 3.

```bash
cd node
npm ci
cp ../.env.example ../.env     # then set the SRC_*_SECRET values
```

The app refuses to start if any `secret_env` listed in `config/sources.yaml` is unset.

## Run

```bash
cd node
npm run dev                              # dashboard at http://localhost:8000 (PORT to change it)
npm run send-samples                     # send the sample alerts in fixtures/sample_alerts.json
npm run generate-traffic                 # send 24 hours of synthetic API traffic for 7 apps
python ../sample_app/shop.py             # sample app writing sample_app/logs/shop.log
npm run watch-logs                       # send its errors and API calls to the app
```

Or set `DEMO_MODE=true` and the app does all of that by itself.

Production: `npm run build && npm start`, or the [Dockerfile](Dockerfile) at the repository root.

The previous Python version (FastAPI) is tagged `python-final`. It uses the same config, database tables and
endpoints, so it can still be deployed from that tag with the data the Node.js version saved.

## Saved data

Alerts, API calls and repeat counts are saved to the database in `DATABASE_URL` and loaded
back on startup, so they survive restarts and redeploys:

- `sqlite:///data/triage.db` (default): a local file.
- `postgresql://...`: Postgres. Use this on Render, whose disk is wiped on every deploy.
- empty: memory only (what the tests use).

## Deploy on Render

Use the Docker runtime (the [Dockerfile](Dockerfile) at the repository root; it includes Python for the
demo's sample shop). Set these environment variables on the web service:

- `SRC_DATADOG_SECRET`, `SRC_CLOUDWATCH_SECRET`, `SRC_AZURE_SECRET`, `SRC_GENERIC_SECRET`
- `DATABASE_URL`: the Postgres connection string (Render Postgres "Internal Database URL", or e.g. Neon)
- `DEMO_MODE=true`: runs the sample shop and log watcher inside the app, and on the first start
  loads the sample alerts and 24 hours of API traffic for every sample application.

## Test

```bash
cd node
npm test                                 # all tests
npx vitest run --coverage                # with coverage
TEST_POSTGRES_URL=postgresql://... npm test   # also run the database tests on Postgres
```

`node/test/golden/` holds outputs recorded from the Python version; the golden tests check that the Node.js
version gives the same results.
