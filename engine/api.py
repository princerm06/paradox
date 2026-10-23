from contextlib import asynccontextmanager
import os
from pathlib import Path
from typing import List, Literal, Optional
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import httpx
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from engine.service import Conflict, Engine, Unavailable


class SproutRequest(BaseModel):
    name: str = Field(default="Popular feed", min_length=1, max_length=120)
    modification: Literal["popular_feed", "none"] = "popular_feed"
    parent_id: Optional[str] = Field(default=None, min_length=1)


class RestoreRequest(BaseModel):
    snapshot_id: str


class Timeline(BaseModel):
    id: str
    parent_id: Optional[str]
    name: str
    status: Literal["pending", "confirmed", "declined"]
    created_at: str
    snapshot_id: str
    modification: Optional[str]
    is_active: bool


class TimelineList(BaseModel):
    timelines: List[Timeline]
    active_timeline_id: str
    app_url: str


class Snapshot(BaseModel):
    id: str
    timeline_id: str
    created_at: str


class SnapshotList(BaseModel):
    snapshots: List[Snapshot]


HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "content-encoding"}


def create_app(state_dir: Optional[Path] = None, runtime_port: int = 8001, runtime_source: Optional[Path] = None, app_url: Optional[str] = None):
    public_app_url = app_url if app_url is not None else os.environ.get("PARADOX_APP_URL")
    if public_app_url is not None:
        parsed_url = urlsplit(public_app_url)
        if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc or parsed_url.query or parsed_url.fragment or parsed_url.username or parsed_url.password:
            raise ValueError("app_url / PARADOX_APP_URL must be an absolute HTTP(S) URL without credentials, query or fragment")
        public_app_url = public_app_url.rstrip("/") + "/"
    engine = Engine(
        Path(state_dir or os.environ.get("PARADOX_STATE_DIR", ".paradox")),
        Path(runtime_source or Path(__file__).resolve().parent.parent / "demo_app"),
        runtime_port,
    )

    @asynccontextmanager
    async def lifespan(application):
        await run_in_threadpool(engine.start)
        try:
            yield
        finally:
            await run_in_threadpool(engine.close)

    application = FastAPI(title="Paradox Timeline Engine", version="0.1.0", lifespan=lifespan)
    application.state.engine = engine
    application.add_middleware(
        CORSMiddleware,
        allow_origins=[f"http://{host}:{port}" for host in ("localhost", "127.0.0.1") for port in (3000, 5173)],
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

    @application.exception_handler(KeyError)
    async def missing(request, error):
        return JSONResponse(status_code=404, content={"detail": error.args[0]})

    @application.exception_handler(Conflict)
    async def conflict(request, error):
        return JSONResponse(status_code=409, content={"detail": str(error)})

    @application.exception_handler(Unavailable)
    async def unavailable(request, error):
        return JSONResponse(status_code=503, content={"detail": str(error)})

    @application.get("/api/health")
    def health():
        return {"status": "ok" if engine.runtime.running else "degraded", "active_timeline_id": engine.active_id, "runtime_running": engine.runtime.running}

    @application.get("/api/timelines", response_model=TimelineList)
    def timelines(request: Request):
        with engine.gate:
            rows = engine.storage.connection.execute("SELECT id FROM timelines ORDER BY created_at,id").fetchall()
            return {"timelines": [engine.view(row[0]) for row in rows], "active_timeline_id": engine.active_id, "app_url": public_app_url or str(request.base_url) + "app/"}

    @application.post("/api/timelines/sprout", status_code=201, response_model=Timeline)
    def sprout(body: SproutRequest):
        with engine.gate:
            return engine.sprout(body.name, body.modification, body.parent_id)

    @application.post("/api/timelines/{timeline_id}/activate", response_model=Timeline)
    def activate(timeline_id: str):
        with engine.gate:
            return engine.activate(timeline_id)

    @application.post("/api/timelines/{timeline_id}/confirm", response_model=Timeline)
    def confirm(timeline_id: str):
        with engine.gate:
            return engine.decide(timeline_id, "confirmed")

    @application.post("/api/timelines/{timeline_id}/decline", response_model=Timeline)
    def decline(timeline_id: str):
        with engine.gate:
            return engine.decide(timeline_id, "declined")

    @application.get("/api/timelines/{timeline_id}/snapshots", response_model=SnapshotList)
    def snapshots(timeline_id: str):
        with engine.gate:
            engine.storage.timeline(timeline_id)
            rows = engine.storage.connection.execute("SELECT * FROM snapshots WHERE timeline_id=? ORDER BY created_at,id", (timeline_id,)).fetchall()
            return {"snapshots": [dict(row) for row in rows]}

    @application.post("/api/timelines/{timeline_id}/snapshots", status_code=201, response_model=Snapshot)
    def checkpoint(timeline_id: str):
        with engine.gate:
            engine.require_available(timeline_id)
            if timeline_id != engine.active_id:
                raise Conflict("Only the active timeline can be checkpointed")
            return engine.checkpoint()

    @application.post("/api/timelines/{timeline_id}/restore", response_model=Timeline)
    def restore(timeline_id: str, body: RestoreRequest):
        with engine.gate:
            return engine.restore(timeline_id, body.snapshot_id)

    def forward(path, method, query, headers, body, app_prefix):
        with engine.gate:
            if not engine.runtime.running:
                raise Unavailable("Application runtime is not running")
            filtered = {key: value for key, value in headers.items() if key.lower() not in HOP_HEADERS}
            try:
                with httpx.Client(trust_env=False, timeout=10, follow_redirects=False) as client:
                    upstream = client.request(method, engine.runtime.url + "/" + path, params=query, headers=filtered, content=body)
            except httpx.HTTPError as error:
                raise Unavailable("Application runtime request failed") from error
            response_headers = {key: value for key, value in upstream.headers.items() if key.lower() not in HOP_HEADERS}
            response_headers["cache-control"] = "no-store"
            if "location" in response_headers:
                location = urlsplit(response_headers["location"])
                if not location.netloc or location.netloc == urlsplit(engine.runtime.url).netloc:
                    response_headers["location"] = app_prefix + location.path + ("?" + location.query if location.query else "") + ("#" + location.fragment if location.fragment else "")
            return Response(upstream.content, status_code=upstream.status_code, headers=response_headers)

    @application.api_route("/app/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"], include_in_schema=False)
    async def proxy(request: Request, path: str):
        body = await request.body()
        app_prefix = urlsplit(public_app_url).path.rstrip("/") if public_app_url else request.scope.get("root_path", "").rstrip("/") + "/app"
        return await run_in_threadpool(forward, path, request.method, request.query_params.multi_items(), request.headers, body, app_prefix)

    return application


app = create_app()
