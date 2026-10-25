import json
from pathlib import Path
import shutil
import sqlite3
import sys
import threading
from types import SimpleNamespace
from uuid import uuid4

import pytest

from engine import imported_agent_sandbox as sandbox
from engine.adapters.fastapi_sqlite import ADAPTER
from engine.generations import Generations, InvalidGeneration


@pytest.fixture
def profile():
    return ADAPTER.profile(dict(adapter=ADAPTER.id, app="pkg.main:app", tests="tests",
                                health_path="/health", state_env="PARADOX_APP_DIR"))


def test_generation_availability_receives_imported_profile_and_no_default_droid(tmp_path, profile):
    engine = SimpleNamespace(root=tmp_path, profile=profile, gate=threading.RLock(), require_available=lambda parent: None)
    generations = Generations(engine)
    calls = []

    def unavailable(provider, profile):
        calls.append((provider, profile))
        return {"available": False, "reason": "offline disabled"}

    generations.providers.availability = unavailable
    with pytest.raises(InvalidGeneration, match="explicit agent provider"):
        generations.create("parent", "request", "future", None, False)
    assert not calls
    with pytest.raises(InvalidGeneration, match="offline disabled"):
        generations.create("parent", "request", "future", "droid", False)
    assert calls == [("droid", profile)]
    assert not generations.root.exists()


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS agent confinement required")
def test_restart_cleans_only_persisted_agent_state(tmp_path, profile):
    root = tmp_path / "engine"
    root.mkdir()
    identifier = str(uuid4())
    code = root / "generations" / identifier / "workspace" / "code"
    (code / "tests").mkdir(parents=True)
    (code / "tests" / "test_original.py").write_text("frozen")
    unrelated = tmp_path / "unrelated" / "code"
    shutil.copytree(code, unrelated)
    operation_paths = []
    for directory in (code, unrelated):
        command, environment = sandbox.prepare(directory, [sys.executable, "-I", "-c", "pass"], {}, profile)
        secret = Path(environment["HOME"]) / ".factory" / "session"
        secret.write_text("dummy private session")
        operation_paths.append(secret)
    record = dict(id=identifier, provider="droid", status="generating", parent_id="parent", created_at="now")
    with sqlite3.connect(root / "engine.sqlite3") as connection:
        connection.execute("CREATE TABLE generations (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        connection.execute("INSERT INTO generations VALUES (?,?)", (identifier, json.dumps(record)))
    generations = Generations(SimpleNamespace(root=root, profile=profile))
    try:
        generations.start()
        recovered = generations.get(identifier)
        assert recovered["status"] == "failed" and recovered["error"]["stage"] == "engine"
        assert not operation_paths[0].exists()
        assert operation_paths[1].read_text() == "dummy private session"
        assert (code / "tests/test_original.py").read_text() == "frozen"
    finally:
        generations.close()
        sandbox.cleanup(code)
        sandbox.cleanup(unrelated)


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS agent confinement required")
def test_enforcement_probes_never_receive_agent_credentials(tmp_path, profile, monkeypatch):
    code = tmp_path / "future" / "code"
    (code / "tests").mkdir(parents=True)
    (code / "tests" / "test_original.py").write_text("frozen")
    sentinels = dict(FACTORY_API_KEY="dummy-factory", PARADOX_TOKEN="dummy-bearer",
                     PARADOX_SHELL_TOKEN="dummy-shell", ANTHROPIC_API_KEY="dummy-other")
    for name, value in sentinels.items():
        monkeypatch.setenv(name, value)
    real_run = sandbox.subprocess.run
    received = []

    def checked_run(*args, **kwargs):
        received.append(kwargs["env"])
        assert not set(sentinels).intersection(kwargs["env"])
        return real_run(*args, **kwargs)

    monkeypatch.setattr(sandbox.subprocess, "run", checked_run)
    try:
        assert sandbox.availability_reason() is None
        command, environment = sandbox.prepare(code, [sys.executable, "-I", "-c", "pass"], sentinels, profile)
        assert received and environment["FACTORY_API_KEY"] == sentinels["FACTORY_API_KEY"]
    finally:
        sandbox.cleanup(code)
