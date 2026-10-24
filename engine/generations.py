from collections import deque
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import threading
import time
from uuid import uuid4

from engine.jobs import Cancelled, JobControl, log_line, redact, scrubbed_environment
from engine.providers import Providers
from engine.service import Conflict, Unavailable
from engine.storage import copy_tree, now
from engine.validation import TEST_BOOTSTRAP, changes, files, guard, reject_bytecode, test_counts, validate_runtime


TERMINAL = {"succeeded", "failed", "cancelled"}


class InvalidGeneration(Exception):
    pass


class Generations:
    def __init__(self, engine):
        self.engine = engine
        self.root = engine.root / "generations"
        self.providers = Providers()
        self.lock = threading.RLock()
        self.connection = None
        self.executor = None
        self.controls = {}
        self.closing = False

    def start(self):
        self.root.mkdir(exist_ok=True)
        self.connection = sqlite3.connect(self.engine.root / "engine.sqlite3", check_same_thread=False, timeout=30)
        self.connection.execute("CREATE TABLE IF NOT EXISTS generations (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        self.connection.commit()
        for generation in self.listing():
            if generation["status"] not in TERMINAL:
                self.update(generation["id"], status="failed", finished_at=now(), error={"stage": "engine", "message": "Engine restarted before generation completed"})
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="fork-generation")

    def close(self):
        self.closing = True
        with self.lock:
            for control in self.controls.values():
                control.cancel()
        if self.executor:
            self.executor.shutdown(wait=True)
        if self.connection:
            self.connection.close()
            self.connection = None

    def get(self, generation_id):
        with self.lock:
            row = self.connection.execute("SELECT data FROM generations WHERE id=?", (generation_id,)).fetchone()
            if row is None:
                raise KeyError("Generation not found")
            return json.loads(row[0])

    def listing(self, parent_id=None):
        with self.lock:
            records = [json.loads(row[0]) for row in self.connection.execute("SELECT data FROM generations")]
        return sorted((record for record in records if parent_id is None or record["parent_id"] == parent_id), key=lambda record: (record["created_at"], record["id"]), reverse=True)

    def update(self, generation_id, **fields):
        with self.lock:
            generation = self.get(generation_id)
            if generation["status"] in TERMINAL:
                return generation
            generation.update(fields, updated_at=now())
            with self.connection:
                self.connection.execute("UPDATE generations SET data=? WHERE id=?", (json.dumps(generation), generation_id))
            return generation

    def create(self, parent_id, prompt, name, provider, activate_on_success):
        provider = provider or self.providers.default
        with self.engine.gate:
            self.engine.require_available(parent_id)
        availability = self.providers.availability(provider)
        if not availability["available"]:
            raise InvalidGeneration(f"Agent provider '{provider}' is unavailable: {availability['reason']}")
        generation_id = str(uuid4())
        directory = self.root / generation_id
        directory.mkdir()
        (directory / "agent.log").touch()
        (directory / "validation.log").touch()
        (directory / "diff.patch").touch()
        record = {
            "id": generation_id, "parent_id": parent_id, "name": name or prompt[:60], "prompt": prompt,
            "provider": provider, "status": "queued", "timeline_id": None, "base_snapshot_id": None,
            "activate_on_success": activate_on_success, "created_at": now(), "updated_at": now(),
            "finished_at": None, "agent": None, "changes": None, "evaluation": None, "error": None,
        }
        with self.lock:
            if self.closing:
                raise Unavailable("Engine is shutting down")
            with self.connection:
                self.connection.execute("INSERT INTO generations VALUES (?,?)", (generation_id, json.dumps(record)))
            self.controls[generation_id] = JobControl()
            self.executor.submit(self.run, generation_id)
        return record

    def cancel(self, generation_id):
        with self.lock:
            generation = self.get(generation_id)
            if generation["status"] in TERMINAL:
                raise Conflict("Generation is already terminal")
            control = self.controls.get(generation_id)
            if control:
                control.cancel()
            stage = {"queued": "prepare", "preparing": "prepare", "generating": "agent", "validating": "tests"}.get(generation["status"], "engine")
            return self.update(generation_id, status="cancelled", finished_at=now(), error={"stage": stage, "message": "Cancelled by user"})

    def logs(self, generation_id, stream, tail):
        self.get(generation_id)
        path = self.root / generation_id / (stream + ".log")
        with path.open(encoding="utf-8", errors="replace") as output:
            lines = list(deque(output, maxlen=tail))
        return {"stream": stream, "lines": [redact(line.rstrip("\n")) for line in lines]}

    def diff(self, generation_id):
        self.get(generation_id)
        return (self.root / generation_id / "diff.patch").read_text(encoding="utf-8", errors="replace")

    def run(self, generation_id):
        control = self.controls[generation_id]
        directory = self.root / generation_id
        validation_log = directory / "validation.log"
        evaluation = {"passed": False, "checks": [], "tests": None, "boot_ms": None}
        stage = "prepare"
        started = time.monotonic()

        def passed(name, started_at, detail=None):
            nonlocal stage
            evaluation["checks"].append({"name": name, "status": "passed", "duration_ms": round((time.monotonic() - started_at) * 1000), "detail": detail})
            log_line(validation_log, name + ": passed" + (" — " + detail if detail else ""))
            self.update(generation_id, evaluation=evaluation)
            if name == "boot":
                stage = "smoke"

        try:
            control.check()
            generation = self.update(generation_id, status="preparing")
            with self.engine.gate:
                control.check()
                parent = self.engine.require_available(generation["parent_id"])
                if parent["id"] == self.engine.active_id:
                    base_snapshot_id = self.engine.checkpoint()["id"]
                else:
                    base_snapshot_id = parent["snapshot_id"]
                base = self.engine.storage.snapshots / base_snapshot_id
                copy_tree(base, directory / "workspace")
                self.update(generation_id, base_snapshot_id=base_snapshot_id)
            code = directory / "workspace" / "code"
            base_files = files(base / "code")
            control.check()
            stage = "agent"
            started = time.monotonic()
            self.update(generation_id, status="generating")
            agent = self.providers.run(generation["provider"], generation["prompt"], code, control, directory / "agent.log")
            self.update(generation_id, agent=agent)
            if agent["exit_code"] != 0:
                raise RuntimeError("Agent exited with a nonzero status; inspect agent logs")
            passed("agent", started)
            self.update(generation_id, status="validating")
            control.check()
            stage = "guard"
            started = time.monotonic()
            reject_bytecode(code)
            current_files = files(code)
            changed, patch = changes(base_files, current_files)
            self.update(generation_id, changes=changed)
            (directory / "diff.patch").write_text(patch, encoding="utf-8")
            guard(base_files, current_files, changed)
            passed("guard", started)
            stage = "compile"
            started = time.monotonic()
            result = control.run([sys.executable, "-m", "compileall", "-q", "demo_app"], code, validation_log, 120)
            if result:
                raise RuntimeError("Python compilation failed; inspect validation logs")
            passed("compile", started)
            stage = "tests"
            started = time.monotonic()
            report = directory / "tests.xml"
            test_environment = scrubbed_environment()
            test_environment["PARADOX_APP_DIR"] = str(directory / "test-state")
            result = control.run([sys.executable, "-c", TEST_BOOTSTRAP, str(base / "code/demo_app/tests/conftest.py"), "-q", "--noconftest", "-p", "no:cacheprovider", "-c", os.devnull, "--rootdir", str(code), "demo_app/tests", "--junitxml", str(report)], code, validation_log, 120, environment=test_environment)
            evaluation["tests"] = test_counts(report)
            self.update(generation_id, evaluation=evaluation)
            if result:
                raise RuntimeError("Generated application tests failed; inspect validation logs")
            passed("tests", started, f"{evaluation['tests']['passed']} passed")
            stage = "boot"
            started = time.monotonic()
            evaluation["boot_ms"] = validate_runtime(directory, code, base / "state", control, validation_log, passed)
            control.check()
            final_files = files(code)
            if final_files != current_files:
                stage = "adopt"
                raise RuntimeError("Validation changed generated source; refusing adoption")
            evaluation["passed"] = True
            stage = "adopt"
            self.adopt(generation_id, base, code, evaluation, control)
        except Cancelled:
            if self.closing:
                self.update(generation_id, status="failed", finished_at=now(), error={"stage": "engine", "message": "Engine stopped before generation completed"})
        except Exception as error:
            detail = redact(str(error))[:2000] or type(error).__name__
            log_line(validation_log, stage + ": failed — " + detail)
            if stage in {"agent", "guard", "compile", "tests", "boot", "smoke"}:
                evaluation["checks"].append({"name": stage, "status": "failed", "duration_ms": round((time.monotonic() - started) * 1000), "detail": detail})
            evaluation["passed"] = False
            fields = {"status": "failed", "finished_at": now(), "error": {"stage": stage, "message": detail}, "evaluation": evaluation if evaluation["checks"] else None}
            if stage == "agent" and self.get(generation_id)["agent"] is None:
                fields["agent"] = {"exit_code": -1, "session_id": None, "duration_ms": round((time.monotonic() - started) * 1000), "summary": None, "usage": {"input_tokens": None, "output_tokens": None, "factory_credits": None}}
            self.update(generation_id, **fields)
        finally:
            with self.lock:
                self.controls.pop(generation_id, None)

    def adopt(self, generation_id, base, code, evaluation, control):
        timeline_id = str(uuid4())
        snapshot_id = str(uuid4())
        destination = self.engine.storage.snapshots / snapshot_id
        temporary = destination.with_name(snapshot_id + ".tmp")
        committed = False
        try:
            temporary.mkdir()
            copy_tree(code, temporary / "code")
            copy_tree(base / "state", temporary / "state")
            temporary.rename(destination)
            with self.engine.gate:
                control.check()
                generation = self.get(generation_id)
                self.engine.require_available(generation["parent_id"])
                outgoing = None
                stopped = False
                try:
                    if generation["activate_on_success"]:
                        self.engine.runtime.stop()
                        stopped = True
                        outgoing = self.engine.storage.snapshot(self.engine.active_id)
                        with self.engine.storage.connection:
                            self.engine.storage.set_setting("transition", json.dumps({"snapshot_id": outgoing["id"], "child_id": timeline_id}))
                        control.check()
                        self.engine.storage.materialize(destination)
                        self.engine.runtime.start()
                    with self.lock:
                        control.check()
                        generation = self.get(generation_id)
                        generation.update(status="succeeded", timeline_id=timeline_id, evaluation=evaluation, finished_at=now(), updated_at=now())
                        with self.engine.storage.connection:
                            self.engine.storage.connection.execute(
                                "INSERT INTO timelines (id,parent_id,name,status,created_at,snapshot_id,modification,generation_id) VALUES (?,?,?,'pending',?,?,'ai',?)",
                                (timeline_id, generation["parent_id"], generation["name"], now(), snapshot_id, generation_id),
                            )
                            self.engine.storage.connection.execute("INSERT INTO snapshots VALUES (?,?,?)", (snapshot_id, timeline_id, now()))
                            self.engine.storage.connection.execute("UPDATE generations SET data=? WHERE id=?", (json.dumps(generation), generation_id))
                            if outgoing:
                                self.engine.storage.set_setting("active_id", timeline_id)
                                self.engine.storage.connection.execute("DELETE FROM settings WHERE key='transition'")
                        committed = True
                except Exception:
                    try:
                        if outgoing:
                            self.engine.runtime.stop()
                            self.engine.storage.restore(outgoing["id"])
                        if stopped:
                            self.engine.runtime.start()
                        if outgoing:
                            with self.engine.storage.connection:
                                self.engine.storage.connection.execute("DELETE FROM settings WHERE key='transition'")
                    except Exception as rollback_error:
                        raise Unavailable("Generation adoption and rollback failed; restart engine to recover") from rollback_error
                    raise
        finally:
            if not committed:
                for orphan in (temporary, destination):
                    if orphan.exists():
                        shutil.rmtree(orphan)
