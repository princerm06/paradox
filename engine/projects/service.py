from contextlib import contextmanager
import json
import logging
import os
from pathlib import Path
import shutil
import stat
import tempfile
import threading
from typing import Dict, Literal, Optional
from uuid import uuid4

from pydantic import Field

from engine.adapters import exec_sandbox
from engine.adapters.fastapi_sqlite import ADAPTER
from engine.generations import Generations, TERMINAL
from engine.projects.importer import import_head
from engine.repositories.git import RepositoryError
from engine.repositories.models import AdapterConfig, StrictModel
from engine.service import Engine
from engine.storage import now


class Base(StrictModel):
    commit: str = Field(pattern=r"^([a-f0-9]{40}|[a-f0-9]{64})$")
    branch: Optional[str]
    dirty: bool


class Preview(StrictModel):
    status: Literal["stopped", "starting", "running", "failed"]
    url: Optional[str]
    timeline_id: Optional[str]


class Project(StrictModel):
    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    repository_id: str = Field(pattern=r"^[A-Za-z0-9_-]{12}$")
    name: str
    adapter: Literal["fastapi-sqlite-v1"]
    configuration: AdapterConfig
    base: Base
    created_at: str
    status: Literal["ready", "open", "unavailable"]
    active_timeline_id: Optional[str]
    runtime: Preview


def stopped():
    return {"status": "stopped", "url": None, "timeline_id": None}


class Projects:
    def __init__(self, registry):
        self.registry = registry
        self.root = registry.state_dir / "projects"
        self.records: Dict[str, dict] = {}
        self.live = {}
        self.lock = threading.RLock()
        self.registry.on_revoke = self.revoke

    def start(self):
        self.root.mkdir(parents=True, exist_ok=True)
        if self.root.is_symlink():
            raise RepositoryError("import_rejected", "Project state directory must not be a symlink")
        for directory in sorted(self.root.iterdir()):
            if directory.is_symlink() or not directory.is_dir():
                continue
            if directory.name.startswith(".import-"):
                shutil.rmtree(directory)
                continue
            try:
                descriptor = os.open(directory / "project.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(descriptor, "rb") as source:
                    metadata = os.fstat(source.fileno())
                    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 65536:
                        raise ValueError("Invalid project metadata")
                    project = Project.model_validate_json(source.read(65537)).model_dump()
                if project["id"] != directory.name or any(record["repository_id"] == project["repository_id"] for record in self.records.values()):
                    raise ValueError("Invalid project identity")
                project.update(status="ready", runtime=stopped())
                self.records[project["id"]] = project
            except (OSError, ValueError):
                logging.getLogger(__name__).warning("Project metadata skipped: project_unavailable")

    def save(self, record):
        Project.model_validate(record)
        directory = self.root / record["id"]
        descriptor, temporary = tempfile.mkstemp(prefix=".project-", dir=directory)
        try:
            with os.fdopen(descriptor, "w") as target:
                json.dump(record, target, ensure_ascii=True)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, directory / "project.json")
        finally:
            Path(temporary).unlink(missing_ok=True)

    def record(self, pid):
        if pid not in self.records:
            raise RepositoryError("unknown_project", "Unknown project id", 404)
        return self.records[pid]

    def require_trust(self, record):
        try:
            trusted = (self.registry.is_trusted(record["repository_id"])
                       and self.registry.configuration(record["repository_id"]) == record["configuration"])
        except RepositoryError:
            trusted = False
        if not trusted:
            raise RepositoryError("trust_required", "Execution approval for this configuration is required", 403)

    def require_sandbox(self):
        if exec_sandbox.availability_reason():
            raise RepositoryError("execution_sandbox_unavailable", "Project execution sandbox is unavailable", 503)

    def get(self, pid):
        with self.lock:
            record = self.record(pid)
            view = json.loads(json.dumps(record))
            try:
                self.require_trust(record)
                self.require_sandbox()
                view["status"] = "ready"
            except RepositoryError:
                view.update(status="unavailable", runtime=stopped())
            if pid in self.live:
                engine, unused = self.live[pid]
                view["active_timeline_id"] = engine.active_id
                view["runtime"] = {"status": "running" if engine.runtime.running else "failed",
                                   "url": engine.runtime.url + "/" if engine.runtime.running else None,
                                   "timeline_id": engine.active_id if engine.runtime.running else None}
                if view["status"] != "unavailable":
                    view["status"] = "open"
            return view

    def list(self):
        with self.lock:
            return [self.get(pid) for pid in sorted(self.records)]

    def create(self, repository_id):
        with self.lock:
            repository = self.registry.get(repository_id)
            configuration = self.registry.configuration(repository_id)
            if not configuration:
                raise RepositoryError("validation_required", "Save a validated configuration before import")
            candidate = {"repository_id": repository_id, "configuration": configuration}
            self.require_trust(candidate)
            self.require_sandbox()
            if any(record["repository_id"] == repository_id for record in self.records.values()):
                raise RepositoryError("project_exists", "A project already exists for this repository", 409)
            for pid in list(self.live):
                self.close(pid)
            pid = uuid4().hex
            staging = self.root / (".import-" + pid)
            destination = self.root / pid
            engine = None
            published = False
            try:
                base, profile = import_head(self.registry, repository_id, staging / "import/code")
                self.require_trust(candidate)
                engine = Engine(staging, staging / "import/code", 0, profile=profile)
                engine.execution_guard = lambda: self.require_trust(candidate)
                engine.start()
                active = engine.active_id
                engine.close()
                engine = None
                self.require_trust(candidate)
                staging.rename(destination)
                record = {"id": pid, "repository_id": repository_id, "name": repository["name"],
                          "adapter": ADAPTER.id, "configuration": configuration, "base": base,
                          "created_at": now(), "status": "ready", "active_timeline_id": active,
                          "runtime": stopped()}
                self.save(record)
                self.records[pid] = record
                published = True
                if base["dirty"]:
                    logging.getLogger(__name__).warning("Project import: uncommitted_changes_ignored")
                return self.get(pid)
            except RepositoryError:
                raise
            except (OSError, ValueError, RuntimeError) as error:
                raise RepositoryError("import_rejected", "Project import or sandboxed health check failed; worker and subprocess applications are unsupported") from error
            finally:
                if engine:
                    engine.close(checkpoint=False)
                if not published:
                    shutil.rmtree(staging, ignore_errors=True)
                    shutil.rmtree(destination, ignore_errors=True)

    def open(self, pid):
        with self.lock:
            record = self.record(pid)
            self.require_trust(record)
            self.require_sandbox()
            self.registry.checked_root(record["repository_id"])
            if pid in self.live:
                return self.get(pid)
            for current in list(self.live):
                self.close(current)
            profile = ADAPTER.profile(record["configuration"])
            root = self.root / pid
            engine = Engine(root, root / "import/code", 0, profile=profile)
            engine.execution_guard = lambda: self.require_trust(record)
            generations = Generations(engine)
            try:
                engine.start()
                generations.start()
                self.require_trust(record)
                self.live[pid] = (engine, generations)
                record.update(status="open", active_timeline_id=engine.active_id, runtime=stopped())
                self.save(record)
            except BaseException as error:
                self.live.pop(pid, None)
                generations.close()
                engine.close(checkpoint=False)
                record.update(status="unavailable", runtime={"status": "failed", "url": None, "timeline_id": None})
                self.save(record)
                if isinstance(error, (OSError, ValueError, RuntimeError)) and not isinstance(error, RepositoryError):
                    raise RepositoryError("import_rejected", "Project runtime could not start safely; worker and subprocess applications are unsupported") from error
                raise
            return self.get(pid)

    def close(self, pid, checkpoint=True):
        with self.lock:
            record = self.record(pid)
            pair = self.live.pop(pid, None)
            if pair:
                engine, generations = pair
                try:
                    generations.close()
                    record["active_timeline_id"] = engine.active_id
                finally:
                    engine.close(checkpoint=checkpoint)
            record.update(status="ready", runtime=stopped())
            self.save(record)
            return self.get(pid)

    def shutdown(self):
        with self.lock:
            for pid in list(self.live):
                self.close(pid)

    def delete(self, pid):
        with self.lock:
            self.close(pid, checkpoint=False)
            shutil.rmtree(self.root / pid)
            del self.records[pid]

    def engine(self, pid):
        with self.lock:
            self.require_trust(self.record(pid))
            if pid not in self.live:
                raise RepositoryError("project_busy", "Project is closed; open it first", 409)
            return self.live[pid]

    @contextmanager
    def session(self, pid):
        with self.lock:
            engine, generations = self.engine(pid)
            with engine.gate:
                engine.require_execution()
                yield engine, generations

    def revoke(self, repository_id):
        with self.lock:
            for pid, record in self.records.items():
                if record["repository_id"] != repository_id:
                    continue
                pair = self.live.get(pid)
                if pair:
                    engine, generations = pair
                    with engine.gate:
                        with generations.lock:
                            for generation in generations.listing():
                                if generation["status"] not in TERMINAL:
                                    control = generations.controls.get(generation["id"])
                                    if control:
                                        control.cancel()
                                    generations.update(generation["id"], status="failed", finished_at=now(),
                                                       error={"stage": "engine", "message": "trust revoked"})
                    self.close(pid, checkpoint=False)
                record.update(status="unavailable", runtime=stopped())
                self.save(record)
