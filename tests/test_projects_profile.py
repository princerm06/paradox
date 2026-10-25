from contextlib import ExitStack, closing
from dataclasses import replace
import json
from pathlib import Path
import sqlite3

import httpx
import pytest

from engine.adapters.base import DEMO_PROFILE
from engine.runtime import Runtime
from engine.service import Engine
from engine.storage import Storage


SOURCE = Path(__file__).parent / "fixtures/engine_demo"


def test_default_profile_is_shared_by_engine_runtime_and_storage(tmp_path):
    engine = Engine(tmp_path, SOURCE, 0)
    assert engine.profile is DEMO_PROFILE
    assert engine.runtime.profile is DEMO_PROFILE
    try:
        engine.start()
        assert engine.storage.profile is DEMO_PROFILE
        assert (engine.storage.workspace / "code/demo_app/main.py").read_bytes() == (SOURCE / "main.py").read_bytes()
        assert json.loads((engine.storage.workspace / "state/behavior.json").read_text()) == {"feed_order": "chronological"}
    finally:
        engine.close()


def test_explicit_demo_profile_switch_restore_and_restart(tmp_path):
    engine = Engine(tmp_path, SOURCE, 0, profile=DEMO_PROFILE)
    try:
        engine.start()
        parent = engine.active_id
        child = engine.sprout("Popularity", "popular_feed")
        with httpx.Client(base_url=engine.runtime.url, trust_env=False) as client:
            assert client.get("/api/posts").json()["ordering"] == "popular"
            assert client.post("/api/posts", json={"content": "child-only"}).status_code == 201
        saved = engine.checkpoint()
        engine.activate(parent)
        with httpx.Client(base_url=engine.runtime.url, trust_env=False) as client:
            parent_feed = client.get("/api/posts").json()
            assert parent_feed["ordering"] == "chronological"
            assert "child-only" not in [post["content"] for post in parent_feed["posts"]]
        engine.restore(child["id"], saved["id"])
    finally:
        engine.close()
    reopened = Engine(tmp_path, SOURCE, 0, profile=DEMO_PROFILE)
    try:
        reopened.start()
        assert reopened.active_id == child["id"]
        with httpx.Client(base_url=reopened.runtime.url, trust_env=False) as client:
            child_feed = client.get("/api/posts").json()
            assert child_feed["ordering"] == "popular"
            assert "child-only" in [post["content"] for post in child_feed["posts"]]
    finally:
        reopened.close()


def test_runtime_uses_profile_target_readiness_and_state_variable(tmp_path):
    code = tmp_path / "workspace/code/alternate"
    state = tmp_path / "workspace/state"
    code.mkdir(parents=True)
    state.mkdir()
    (code / "__init__.py").write_text("")
    (code / "main.py").write_text('''
import os
from pathlib import Path
from fastapi import FastAPI
Path(os.environ["APP_STATE"], "started").write_text("ready")
app = FastAPI()
@app.get("/ready")
def ready():
    return {"ready": True}
''')
    profile = replace(DEMO_PROFILE, app="alternate.main:app", health_path="/ready", state_env="APP_STATE")
    runtime = Runtime(tmp_path, port=0, profile=profile)
    try:
        runtime.start()
        assert (state / "started").read_text() == "ready"
        with httpx.Client(base_url=runtime.url, trust_env=False) as client:
            assert client.get("/ready").status_code == 200
            assert client.get("/health").status_code == 404
    finally:
        runtime.stop()


@pytest.mark.parametrize("adapter,execution", [
    ("fastapi-sqlite-v1", "sandboxed"),
    ("fastapi-sqlite-v1", "trusted_local"),
    ("demo-v0", "unknown"),
])
def test_runtime_fails_closed_for_unavailable_execution_profiles(tmp_path, monkeypatch, adapter, execution):
    def forbidden_spawn(*arguments, **keywords):
        raise AssertionError("Unsupported profile must not launch code")

    monkeypatch.setattr("engine.runtime.subprocess.Popen", forbidden_spawn)
    monkeypatch.setattr("engine.runtime.exec_sandbox.availability_reason", lambda: "unavailable")
    runtime = Runtime(tmp_path, port=0, profile=replace(DEMO_PROFILE, adapter=adapter, execution=execution))
    with pytest.raises(RuntimeError, match="execution_sandbox_unavailable"):
        runtime.start()
    assert not runtime.running
    assert runtime.log is None
    assert not (tmp_path / "runtime.log").exists()


def test_engine_cannot_initialize_an_imported_project_as_the_demo(tmp_path, monkeypatch):
    def forbidden_spawn(*arguments, **keywords):
        raise AssertionError("Imported project must not execute during the demo-only refactor")

    monkeypatch.setattr("engine.runtime.subprocess.Popen", forbidden_spawn)
    profile = replace(DEMO_PROFILE, adapter="unsupported", execution="sandboxed")
    engine = Engine(tmp_path, SOURCE, 0, profile=profile)
    with pytest.raises(ValueError, match="Unsupported imported project profile"):
        engine.start()
    assert engine.storage is None
    assert engine.lock_file is None
    assert not engine.runtime.running
    assert not (tmp_path / "workspace").exists()


def test_snapshot_uses_recursive_profile_sqlite_patterns_and_restores_state(tmp_path):
    profile = replace(DEMO_PROFILE, sqlite_state_globs=("**/*.sqlite3", "**/*.sqlite", "**/*.db", "**/*.sqlite3"))
    storage = Storage(tmp_path, profile=profile)
    state = storage.workspace / "state"
    (storage.workspace / "code").mkdir(parents=True)
    state.mkdir()
    databases = [state / "nested/deeper/posts.sqlite3", state / "nested/notes.sqlite", state / "settings.db"]
    (state / "counter.json").write_text('{"value": 1}')
    try:
        timeline = storage.create_timeline("Original")
        with ExitStack() as stack:
            for database in databases:
                database.parent.mkdir(parents=True, exist_ok=True)
                connection = stack.enter_context(closing(sqlite3.connect(database)))
                connection.execute("PRAGMA journal_mode=WAL")
                connection.execute("CREATE TABLE entries (value TEXT)")
                connection.execute("INSERT INTO entries VALUES ('original')")
                connection.commit()
                assert Path(str(database) + "-wal").exists()
            saved = storage.snapshot(timeline)
        snapshot_state = storage.snapshots / saved["id"] / "state"
        for database in databases:
            target = snapshot_state / database.relative_to(state)
            assert not Path(str(target) + "-wal").exists()
            assert not Path(str(target) + "-shm").exists()
            with closing(sqlite3.connect(database)) as connection:
                connection.execute("UPDATE entries SET value='changed'")
                connection.commit()
        (state / "counter.json").write_text('{"value": 2}')
        storage.restore(saved["id"])
        for database in databases:
            with closing(sqlite3.connect(database)) as connection:
                assert connection.execute("SELECT value FROM entries").fetchone()[0] == "original"
        assert json.loads((state / "counter.json").read_text()) == {"value": 1}
    finally:
        storage.connection.close()


@pytest.mark.parametrize("pattern", ["../outside.sqlite3", "/outside.sqlite3"])
def test_snapshot_rejects_state_pattern_escape(tmp_path, pattern):
    storage = Storage(tmp_path, profile=replace(DEMO_PROFILE, sqlite_state_globs=(pattern,)))
    (storage.workspace / "code").mkdir(parents=True)
    (storage.workspace / "state").mkdir()
    try:
        timeline = storage.create_timeline("Original")
        with pytest.raises(ValueError, match="within the state directory"):
            storage.snapshot(timeline)
        assert list(storage.snapshots.iterdir()) == []
        assert storage.timeline(timeline)["snapshot_id"] is None
    finally:
        storage.connection.close()


def test_snapshot_does_not_silently_accept_database_directory(tmp_path):
    storage = Storage(tmp_path)
    (storage.workspace / "code").mkdir(parents=True)
    (storage.workspace / "state/app.sqlite3").mkdir(parents=True)
    try:
        timeline = storage.create_timeline("Original")
        with pytest.raises(ValueError, match="regular file"):
            storage.snapshot(timeline)
        assert list(storage.snapshots.iterdir()) == []
    finally:
        storage.connection.close()
