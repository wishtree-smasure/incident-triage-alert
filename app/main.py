"""FastAPI app: receives signed alerts and API-call logs, and serves the dashboard."""

import json
import uuid
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from pydantic import ValidationError

from app import analysis, dashboard, demo
from app.db import open_database
from app.dedup import DedupCache, fingerprint
from app.models import ApiCallBatch, Investigation
from app.normalizers import NormalizationError, normalize
from app.playbook import load_playbook, suggest
from app.location import code_location
from app.registry import Registry, Source, load_registry
from app.security import is_valid_signature
from app.settings import PROJECT_ROOT, Settings
from app.store import MAX_ITEMS, InvestigationStore
from app.traffic import TrafficStore

templates = Jinja2Templates(directory=PROJECT_ROOT / "app" / "templates")
templates.env.globals["code_location"] = code_location


def run_investigation(investigation_id: str) -> None:
    """Placeholder. The agent loop is added in build step 3."""


async def verified_body(request: Request, source_id: str) -> tuple[Source, bytes]:
    """The checks every incoming request must pass: known source (404), correct signature (401)."""
    registry = request.app.state.registry
    source = registry.get(source_id)
    if source is None:
        raise HTTPException(404, "unknown source")
    body = await request.body()
    if not is_valid_signature(registry.secret_for(source_id), body, request.headers.get("X-Signature")):
        raise HTTPException(401, "invalid or missing signature")
    return source, body


def create_app(registry: Registry | None = None, settings: Settings | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        load_dotenv(PROJECT_ROOT / ".env")  # makes SRC_*_SECRET available to the registry
        app.state.settings = settings or Settings()
        app.state.registry = registry or load_registry(app.state.settings.sources_path)
        app.state.playbook = load_playbook(app.state.settings.playbook_path)
        db = open_database(app.state.settings.database_url, PROJECT_ROOT)
        app.state.dedup = DedupCache(ttl_minutes=app.state.settings.dedup_ttl_min, db=db)
        app.state.store = InvestigationStore(db=db)
        app.state.traffic = TrafficStore(db=db)
        stop_demo = demo.start(app.state.registry, app.state.store, app.state.traffic) if app.state.settings.demo_mode else None
        yield
        if stop_demo:
            stop_demo.set()

    app = FastAPI(title="Incident Triage Agent", lifespan=lifespan)

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/", response_class=HTMLResponse)
    def dashboard_page(
        request: Request,
        view: str | None = None,
        app: str | None = None,
        source: str | None = None,
        level: str | None = None,
        q: str | None = None,
        partial: bool = False,
    ):
        state = request.app.state
        view = "analysis" if view == "analysis" else None
        if level not in ("alert", "warning"):
            level = None
        alerts = state.store.newest_first()
        context = dashboard.build(alerts, state.registry, app, source, level, view, q)
        if partial and view is None:
            # Just the live part of the Alerts view: the page script swaps it in without a reload.
            return templates.TemplateResponse(request, "_alerts.html", context)

        if view == "analysis":
            by_app = {name: state.traffic.for_app(name) for name in state.traffic.apps()}
            context["traffic_apps"] = list(by_app)
            context["app_rows"] = analysis.overview_of_apps(by_app, alerts)
            # Applications with alerts but no API calls yet: listed too, so none look missing.
            context["quiet_apps"] = [
                {"app": name, "open_alerts": n, "show_stoppers": sev1}
                for name in sorted({i.service for i in alerts} - set(by_app))
                for n, sev1 in [analysis.open_alerts(alerts, name)]
            ]
            context["analysis"] = None
            if app in by_app:
                context["analysis"] = analysis.analyze_app(app, by_app[app], alerts)

        refresh = 30 if view == "analysis" else None  # the Alerts view updates itself with a script
        return templates.TemplateResponse(request, "index.html", {**context, "refresh": refresh})

    @app.get("/investigations/{investigation_id}", response_class=HTMLResponse)
    def investigation_page(request: Request, investigation_id: str):
        inv = request.app.state.store.get(investigation_id)
        if inv is None:
            # A friendly page, not raw JSON: usually an old link from before a restart.
            context = {"investigation_id": investigation_id, "kept": MAX_ITEMS,
                       "saved": request.app.state.store.db is not None}
            return templates.TemplateResponse(request, "not_found.html", context, status_code=404)
        still_working = inv.status in ("queued", "running")
        context = {
            "inv": inv,
            "source_name": request.app.state.registry.name_of(inv.source_id),
            "refresh": 5 if still_working else None,
        }
        return templates.TemplateResponse(request, "investigation.html", context)

    @app.post("/hooks/{source_id}", status_code=202)
    async def receive_alert(source_id: str, request: Request, background: BackgroundTasks):
        state = request.app.state

        # 1-2. Known source and correct signature?
        source, body = await verified_body(request, source_id)

        # 3. Convert the vendor payload to our common shape.
        try:
            alert = normalize(source, json.loads(body))
        except (json.JSONDecodeError, UnicodeDecodeError, NormalizationError) as exc:
            raise HTTPException(422, str(exc))

        # 4. Same alert still open (or seen in the last few minutes)? Count it on that investigation.
        def state_of(investigation_id: str) -> str | None:
            inv = state.store.get(investigation_id)
            if inv is None:
                return None  # no longer kept: start a new one
            return "open" if inv.status in ("queued", "running") else "closed"

        new_id = uuid.uuid4().hex[:12]
        inv_id, count, duplicate = state.dedup.check(fingerprint(alert), new_id, state_of)

        if duplicate:
            existing = state.store.get(inv_id)
            if existing:
                existing.dedup_count = count
                state.store.save(existing)
        else:
            state.store.add(
                Investigation(
                    id=inv_id,
                    source_id=source.id,
                    service=alert.service,
                    alert=alert,
                    suggestion=suggest(alert, state.playbook),
                )
            )
            background.add_task(run_investigation, inv_id)

        # 5. Answer right away; the investigation runs in the background.
        return {"investigation_id": inv_id, "deduplicated": duplicate, "dedup_count": count}

    @app.post("/requests/{source_id}", status_code=202)
    async def receive_api_calls(source_id: str, request: Request):
        """A batch of API calls from an application's access log: {"calls": [...]}."""
        _, body = await verified_body(request, source_id)
        try:
            batch = ApiCallBatch.model_validate_json(body)
        except ValidationError as exc:
            raise HTTPException(422, f"bad API call batch: {exc.error_count()} problem(s)")
        request.app.state.traffic.add(batch.calls)
        return {"accepted": len(batch.calls)}

    return app


app = create_app()
