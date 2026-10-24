from contextlib import asynccontextmanager
import os
import secrets
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import httpx
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from engine.service import Conflict, Engine, Unavailable
from engine.generations import Generations, InvalidGeneration


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
    generation_id: Optional[str]
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


class GenerationRequest(BaseModel):
    parent_id: str = Field(min_length=1)
    prompt: str = Field(min_length=1, max_length=4000)
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    provider: Optional[Literal["droid", "scripted", "claude"]] = None
    activate_on_success: bool = False


class Generation(BaseModel):
    id: str
    parent_id: str
    name: str
    prompt: str
    provider: str
    status: Literal["queued", "preparing", "generating", "validating", "succeeded", "failed", "cancelled"]
    timeline_id: Optional[str]
    base_snapshot_id: Optional[str]
    activate_on_success: bool
    created_at: str
    updated_at: str
    finished_at: Optional[str]
    agent: Optional[Dict[str, Any]]
    changes: Optional[Dict[str, Any]]
    evaluation: Optional[Dict[str, Any]]
    error: Optional[Dict[str, str]]


class GenerationList(BaseModel):
    generations: List[Generation]


HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "content-encoding"}


def create_app(state_dir: Optional[Path] = None, runtime_port: int = 8001, runtime_source: Optional[Path] = None, app_url: Optional[str] = None):
    token = os.environ.get("PARADOX_TOKEN")
    origins = [origin.strip() for origin in os.environ.get("PARADOX_CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173").split(",") if origin.strip()]
    for origin in origins:
        parsed_origin = urlsplit(origin)
        if "*" in origin or parsed_origin.scheme not in {"http", "https"} or not parsed_origin.netloc or parsed_origin.path or parsed_origin.query or parsed_origin.fragment or parsed_origin.username:
            raise ValueError("PARADOX_CORS_ORIGINS must contain exact HTTP(S) origins, never '*'")
    public_app_url = app_url if app_url is not None else os.environ.get("PARADOX_APP_URL")
    if public_app_url is not None:
        parsed_url = urlsplit(public_app_url)
        if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc or parsed_url.query or parsed_url.fragment or parsed_url.username or parsed_url.password:
            raise ValueError("app_url / PARADOX_APP_URL must be an absolute HTTP(S) URL without credentials, query or fragment")
        public_app_url = public_app_url.rstrip("/") + "/"
    engine = Engine(
        Path(state_dir or os.environ.get("PARADOX_STATE_DIR", ".paradox")),
        Path(runtime_source or os.environ.get("PARADOX_SOURCE_DIR") or Path(__file__).resolve().parent.parent / "demo_app"),
        runtime_port,
    )
    generations = Generations(engine)

    @asynccontextmanager
    async def lifespan(application):
        await run_in_threadpool(engine.start)
        try:
            await run_in_threadpool(generations.start)
            yield
        finally:
            try:
                await run_in_threadpool(generations.close)
            finally:
                await run_in_threadpool(engine.close)

    application = FastAPI(title="Paradox Timeline Engine", version="0.1.0", lifespan=lifespan)
    application.state.engine = engine
    application.state.generations = generations

    @application.middleware("http")
    async def authenticate(request, call_next):
        mutating = request.url.path.startswith("/api/") and request.method in {"POST", "PUT", "PATCH", "DELETE"}
        # Browsers attach Origin to every cross-origin POST, including bodyless ones that skip
        # CORS preflight. Refuse engine mutations from any page outside the allowlist, even
        # without a token; non-browser clients (CLI, tests) send no Origin and are unaffected.
        if mutating and "origin" in request.headers and request.headers["origin"] not in origins:
            return JSONResponse(status_code=403, content={"detail": "Origin not allowed"})
        if token and mutating:
            if not secrets.compare_digest(request.headers.get("authorization", "").encode(), ("Bearer " + token).encode()):
                return JSONResponse(status_code=401, content={"detail": "Missing or invalid token"})
        return await call_next(request)

    application.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization"],
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

    @application.exception_handler(InvalidGeneration)
    async def invalid_generation(request, error):
        return JSONResponse(status_code=422, content={"detail": str(error)})

    @application.get("/api/health")
    def health():
        with engine.gate:
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

    @application.get("/api/agents")
    def agents():
        return generations.providers.listing()

    @application.post("/api/generations", status_code=202, response_model=Generation)
    def generate(body: GenerationRequest):
        return generations.create(body.parent_id, body.prompt, body.name, body.provider, body.activate_on_success)

    @application.get("/api/generations", response_model=GenerationList)
    def generation_list(parent_id: Optional[str] = None):
        if parent_id is not None:
            with engine.gate:
                engine.storage.timeline(parent_id)
        return {"generations": generations.listing(parent_id)}

    @application.get("/api/generations/{generation_id}", response_model=Generation)
    def generation(generation_id: str):
        return generations.get(generation_id)

    @application.get("/api/generations/{generation_id}/logs")
    def generation_logs(generation_id: str, stream: Literal["agent", "validation"] = "agent", tail: int = Query(default=200, ge=1, le=2000)):
        return generations.logs(generation_id, stream, tail)

    @application.get("/api/generations/{generation_id}/diff")
    def generation_diff(generation_id: str):
        return Response(generations.diff(generation_id), media_type="text/plain")

    @application.post("/api/generations/{generation_id}/cancel", response_model=Generation)
    def generation_cancel(generation_id: str):
        return generations.cancel(generation_id)

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
