import os
from contextlib import asynccontextmanager
from pathlib import Path
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool

from engine.repositories.git import RepositoryError
from engine.repositories.inspection import inspect, validate
from engine.repositories.models import Registration, StrictModel, ValidationRequest
from engine.repositories.registry import Registry


def repository_router(state_dir, roots=None, managed=True):
    configured = roots if roots is not None else list(filter(None, os.environ.get("PARADOX_REPOSITORY_ROOTS", "").split(os.pathsep)))
    registry = Registry(configured, Path(state_dir))
    token = os.environ.get("PARADOX_TOKEN")
    shell_token = os.environ.get("PARADOX_SHELL_TOKEN")

    def authorize(request: Request):
        supplied = request.headers.get("authorization", "")
        if not token or not secrets.compare_digest(supplied.encode(), ("Bearer " + token).encode()):
            raise HTTPException(401, "Missing or invalid token")

    def authorize_shell(request: Request):
        if not shell_token:
            raise HTTPException(403, "registration disabled")
        if not secrets.compare_digest(request.headers.get("x-paradox-shell-token", "").encode(), shell_token.encode()):
            raise HTTPException(403, "Invalid shell token")

    def call(operation, *args):
        try:
            return operation(*args)
        except RepositoryError as error:
            raise HTTPException(error.status, {"code": error.code, "message": str(error)}) from error

    @asynccontextmanager
    async def lifespan(application):
        if managed:
            await run_in_threadpool(registry.start)
        yield

    router = APIRouter(prefix="/api/repositories", tags=["repositories"], dependencies=[Depends(authorize)], lifespan=lifespan)
    router.registry = registry
    router.authorize = authorize
    router.authorize_shell = authorize_shell

    @router.get("")
    def listing():
        return {"repositories": registry.listing()}

    @router.post("", status_code=201, dependencies=[Depends(authorize_shell)])
    def register(body: Registration):
        return call(registry.register, body.path)

    @router.post("/{repository_id}/inspect")
    def inspection(repository_id: str, body: StrictModel):
        return call(inspect, registry, repository_id)

    @router.post("/{repository_id}/validate")
    def validation(repository_id: str, body: ValidationRequest):
        return call(validate, registry, repository_id, body.configuration)

    @router.post("/{repository_id}/trust", dependencies=[Depends(authorize_shell)])
    def trust(repository_id: str, body: StrictModel):
        return call(registry.grant_trust, repository_id)

    @router.delete("/{repository_id}/trust", status_code=204, dependencies=[Depends(authorize_shell)])
    def revoke(repository_id: str):
        call(registry.revoke_trust, repository_id)
        return Response(status_code=204)

    @router.delete("/{repository_id}", status_code=204, dependencies=[Depends(authorize_shell)])
    def forget(repository_id: str):
        call(registry.forget, repository_id)
        return Response(status_code=204)

    return router
