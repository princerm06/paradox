import os
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Query, Response

from engine.repositories.models import StrictModel
from engine.repositories.git import RepositoryError


class ImportRequest(StrictModel):
    repository_id: str


def project_router(projects, authorize, authorize_shell):
    from engine.api import (Generation, GenerationList, GenerationRequest, RestoreRequest,
                            Snapshot, SnapshotList, Timeline, TimelineList)

    router = APIRouter(prefix="/api/projects", tags=["projects"], dependencies=[Depends(authorize)])

    @router.get("")
    def listing():
        return {"projects": projects.list()}

    @router.post("", status_code=201)
    def create(body: ImportRequest):
        return projects.create(body.repository_id)

    @router.get("/{pid}")
    def get(pid: str):
        return projects.get(pid)

    @router.post("/{pid}/open")
    def open_project(pid: str, body: StrictModel):
        return projects.open(pid)

    @router.post("/{pid}/close")
    def close_project(pid: str, body: StrictModel):
        return projects.close(pid)

    @router.delete("/{pid}", status_code=204, dependencies=[Depends(authorize_shell)])
    def delete(pid: str):
        projects.delete(pid)
        return Response(status_code=204)

    @router.get("/{pid}/timelines", response_model=TimelineList)
    def timelines(pid: str):
        with projects.session(pid) as (engine, generations):
            rows = engine.storage.connection.execute("SELECT id FROM timelines ORDER BY created_at,id").fetchall()
            return {"timelines": [engine.view(row[0]) for row in rows], "active_timeline_id": engine.active_id,
                    "app_url": engine.runtime.url + "/"}

    @router.post("/{pid}/timelines/{timeline_id}/activate", response_model=Timeline)
    def activate(pid: str, timeline_id: str):
        with projects.session(pid) as (engine, generations):
            return engine.activate(timeline_id)

    @router.post("/{pid}/timelines/{timeline_id}/confirm", response_model=Timeline)
    def confirm(pid: str, timeline_id: str):
        with projects.session(pid) as (engine, generations):
            return engine.decide(timeline_id, "confirmed")

    @router.post("/{pid}/timelines/{timeline_id}/decline", response_model=Timeline)
    def decline(pid: str, timeline_id: str):
        with projects.session(pid) as (engine, generations):
            return engine.decide(timeline_id, "declined")

    @router.get("/{pid}/timelines/{timeline_id}/snapshots", response_model=SnapshotList)
    def snapshots(pid: str, timeline_id: str):
        with projects.session(pid) as (engine, generations):
            engine.storage.timeline(timeline_id)
            rows = engine.storage.connection.execute("SELECT * FROM snapshots WHERE timeline_id=? ORDER BY created_at,id",
                                                     (timeline_id,)).fetchall()
            return {"snapshots": [dict(row) for row in rows]}

    @router.post("/{pid}/timelines/{timeline_id}/snapshots", status_code=201, response_model=Snapshot)
    def checkpoint(pid: str, timeline_id: str):
        with projects.session(pid) as (engine, generations):
            engine.require_available(timeline_id)
            if timeline_id != engine.active_id:
                from engine.service import Conflict
                raise Conflict("Only the active timeline can be checkpointed")
            return engine.checkpoint()

    @router.post("/{pid}/timelines/{timeline_id}/restore", response_model=Timeline)
    def restore(pid: str, timeline_id: str, body: RestoreRequest):
        with projects.session(pid) as (engine, generations):
            return engine.restore(timeline_id, body.snapshot_id)

    @router.get("/{pid}/agents")
    def agents(pid: str):
        with projects.session(pid) as (engine, generations):
            return {"default": "scripted", "providers": [
                generations.providers.availability(provider, profile=engine.profile)
                for provider in engine.profile.providers]}

    @router.post("/{pid}/generations", status_code=202, response_model=Generation)
    def generate(pid: str, body: GenerationRequest):
        if body.provider not in ("scripted", "droid"):
            raise RepositoryError("provider_unsupported", "Imported projects require explicit provider=scripted or droid")
        if body.provider == "droid" and os.environ.get("PARADOX_IMPORTED_DROID_ENABLED") != "1":
            raise RepositoryError("provider_unsupported", "Imported Droid requires explicit operator opt-in; paid calls require separate approval")
        with projects.session(pid) as (engine, generations):
            return generations.create(body.parent_id, body.prompt, body.name, body.provider, body.activate_on_success)

    @router.get("/{pid}/generations", response_model=GenerationList)
    def generation_list(pid: str, parent_id: Optional[str] = None):
        with projects.session(pid) as (engine, generations):
            if parent_id is not None:
                engine.storage.timeline(parent_id)
            return {"generations": generations.listing(parent_id)}

    @router.get("/{pid}/generations/{generation_id}", response_model=Generation)
    def generation(pid: str, generation_id: str):
        with projects.session(pid) as (engine, generations):
            return generations.get(generation_id)

    @router.get("/{pid}/generations/{generation_id}/logs")
    def logs(pid: str, generation_id: str, stream: Literal["agent", "validation"] = "agent",
             tail: int = Query(default=200, ge=1, le=2000)):
        with projects.session(pid) as (engine, generations):
            return generations.logs(generation_id, stream, tail)

    @router.get("/{pid}/generations/{generation_id}/diff")
    def diff(pid: str, generation_id: str):
        with projects.session(pid) as (engine, generations):
            return Response(generations.diff(generation_id), media_type="text/plain")

    @router.post("/{pid}/generations/{generation_id}/cancel", response_model=Generation)
    def cancel(pid: str, generation_id: str):
        with projects.session(pid) as (engine, generations):
            return generations.cancel(generation_id)

    return router
