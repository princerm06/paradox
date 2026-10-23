from contextlib import asynccontextmanager
import os
from pathlib import Path
from typing import Literal, Optional
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


class RestoreRequest(BaseModel):
    snapshot_id: str


HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "content-encoding"}


def create_app(state_dir: Optional[Path] = None, runtime_port: int = 8001, runtime_source: Optional[Path] = None):
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

    @application.get("/api/timelines")
    def timelines():
        with engine.gate:
            rows = engine.storage.connection.execute("SELECT id FROM timelines ORDER BY created_at,id").fetchall()
            return {"timelines": [engine.view(row[0]) for row in rows], "active_timeline_id": engine.active_id, "app_url": "/app/"}

    @application.post("/api/timelines/sprout", status_code=201)
    def sprout(body: SproutRequest):
        with engine.gate:
            return engine.sprout(body.name, body.modification)

    @application.post("/api/timelines/{timeline_id}/activate")
    def activate(timeline_id: str):
        with engine.gate:
            return engine.activate(timeline_id)

    @application.post("/api/timelines/{timeline_id}/confirm")
    def confirm(timeline_id: str):
        with engine.gate:
            return engine.decide(timeline_id, "confirmed")

    @application.post("/api/timelines/{timeline_id}/decline")
    def decline(timeline_id: str):
        with engine.gate:
            return engine.decide(timeline_id, "declined")

    @application.get("/api/timelines/{timeline_id}/snapshots")
    def snapshots(timeline_id: str):
        with engine.gate:
            engine.storage.timeline(timeline_id)
            rows = engine.storage.connection.execute("SELECT * FROM snapshots WHERE timeline_id=? ORDER BY created_at,id", (timeline_id,)).fetchall()
            return {"snapshots": [dict(row) for row in rows]}

    @application.post("/api/timelines/{timeline_id}/snapshots", status_code=201)
    def checkpoint(timeline_id: str):
        with engine.gate:
            engine.require_available(timeline_id)
            if timeline_id != engine.active_id:
                raise Conflict("Only the active timeline can be checkpointed")
            return engine.checkpoint()

    @application.post("/api/timelines/{timeline_id}/restore")
    def restore(timeline_id: str, body: RestoreRequest):
        with engine.gate:
            return engine.restore(timeline_id, body.snapshot_id)

    def forward(path, method, query, headers, body):
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
                    response_headers["location"] = "/app" + location.path + ("?" + location.query if location.query else "")
            return Response(upstream.content, status_code=upstream.status_code, headers=response_headers)

    @application.api_route("/app/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    async def proxy(request: Request, path: str):
        body = await request.body()
        return await run_in_threadpool(forward, path, request.method, request.query_params.multi_items(), request.headers, body)

    return application


app = create_app()
