import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import threading
import time

from fastapi.testclient import TestClient
import pytest

from engine.api import create_app
from engine.jobs import JobControl, scrubbed_environment
from engine.providers import Providers
from engine import providers
from engine.validation import changes, files, guard


BASE = Path(__file__).parent / "fixtures" / "engine_demo"
POPULAR = (Path(__file__).parents[1] / "engine/templates/popular_ranking.py").read_text()


def wait(client, generation_id):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        record = client.get("/api/generations/" + generation_id).json()
        if record["status"] in {"succeeded", "failed", "cancelled"}:
            return record
        time.sleep(0.05)
    raise AssertionError(record)


def start(client, prompt="popular", **fields):
    parent_id = client.get("/api/timelines").json()["active_timeline_id"]
    payload = {"parent_id": parent_id, "prompt": prompt, "provider": "scripted", **fields}
    response = client.post("/api/generations", json=payload)
    assert response.status_code == 202, response.text
    assert response.json()["status"] == "queued"
    return response.json()["id"]


@pytest.fixture
def configured(tmp_path, monkeypatch):
    source = tmp_path / "source"
    shutil.copytree(BASE, source)
    (source / "AGENTS.md").write_text("Edit only this package; preserve existing tests.")
    (source / "tests").mkdir()
    (source / "tests/__init__.py").touch()
    (source / "tests/test_contract.py").write_text("from demo_app import ranking\ndef test_ordering():\n    assert ranking.ORDERING in {'popular', 'chronological'}\n")
    recipes = tmp_path / "recipes"
    recipes.mkdir()
    overlays = [
        ("popular", "popular", {"demo_app/ranking.py": POPULAR}, 0),
        ("slow", "slow", {"demo_app/new_feature.py": "VALUE = 42\n"}, 2),
        ("compile", "invalid syntax", {"demo_app/ranking.py": "def invalid(:\n"}, 0),
        ("tests", "failing tests", {"demo_app/tests/test_failure.py": "def test_failure():\n    assert False\n"}, 0),
        ("guard", "protected tests", {"demo_app/tests/test_contract.py": None}, 0),
        ("outside", "outside edit", {"outside.txt": "not allowed"}, 0),
    ]
    for name, match, overlay, delay in overlays:
        (recipes / (name + ".json")).write_text(json.dumps({"match": match, "files": overlay, "delay_s": delay}))
    monkeypatch.setenv("PARADOX_SCRIPTED_RECIPES", str(recipes))
    monkeypatch.setenv("PARADOX_AGENT", "scripted")
    return {"state_dir": tmp_path / "state", "runtime_port": 0, "runtime_source": source}


@pytest.fixture
def client(configured):
    with TestClient(create_app(**configured)) as connection:
        yield connection


def test_generation_adopts_code_with_base_database_and_keeps_parent_active(client):
    root = client.get("/api/timelines").json()["active_timeline_id"]
    assert client.post("/app/api/posts", json={"content": "before"}).status_code == 201
    generation_id = start(client)
    assert client.post("/app/api/posts", json={"content": "during"}).status_code == 201
    result = wait(client, generation_id)
    assert result["status"] == "succeeded", result
    assert result["finished_at"] and result["base_snapshot_id"]
    assert result["evaluation"]["passed"]
    assert [check["name"] for check in result["evaluation"]["checks"]] == ["agent", "guard", "compile", "tests", "boot", "smoke"]
    timeline = next(item for item in client.get("/api/timelines").json()["timelines"] if item["id"] == result["timeline_id"])
    assert timeline["modification"] == "ai" and timeline["generation_id"] == generation_id
    assert client.get("/api/timelines").json()["active_timeline_id"] == root
    assert client.get("/app/api/posts").json()["ordering"] == "chronological"
    assert "ranking.py" in client.get(f"/api/generations/{generation_id}/diff").text
    assert client.get(f"/api/generations/{generation_id}/logs?stream=validation").json()["lines"]
    assert client.post(f"/api/timelines/{timeline['id']}/activate").status_code == 200
    assert client.get("/app/api/posts").json()["ordering"] == "popular"
    assert client.post(f"/api/generations/{generation_id}/cancel").status_code == 409


@pytest.mark.parametrize("prompt,stage", [("unmatched request", "agent"), ("invalid syntax", "compile"), ("failing tests", "tests"), ("protected tests", "guard"), ("outside edit", "guard")])
def test_generation_failures_never_publish_timelines(client, prompt, stage):
    root = client.get("/api/timelines").json()
    result = wait(client, start(client, prompt))
    assert result["status"] == "failed", result
    assert result["timeline_id"] is None
    assert result["error"]["stage"] == stage
    assert result["evaluation"]["checks"][-1]["name"] == stage
    assert client.get("/api/timelines").json()["active_timeline_id"] == root["active_timeline_id"]
    assert len(client.get("/api/timelines").json()["timelines"]) == 1


def test_two_workers_queue_excess_requests_and_cancellation_is_terminal(client):
    ids = [start(client, "slow") for unused in range(3)]
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        statuses = [client.get("/api/generations/" + generation_id).json()["status"] for generation_id in ids]
        if statuses[:2] == ["generating", "generating"]:
            break
        time.sleep(.02)
    assert statuses[:2] == ["generating", "generating"]
    assert statuses[2] == "queued"
    for generation_id in ids:
        assert client.post(f"/api/generations/{generation_id}/cancel").json()["status"] == "cancelled"
    time.sleep(0.2)
    assert all(wait(client, generation_id)["status"] == "cancelled" for generation_id in ids)
    assert len(client.get("/api/timelines").json()["timelines"]) == 1


def test_failed_activation_adoption_restores_original_and_creates_no_timeline(client, monkeypatch):
    engine = client.app.state.engine
    original = engine.runtime.start
    attempts = []

    def fail_adoption():
        attempts.append(True)
        if len(attempts) == 2:
            raise RuntimeError("injected activation failure")
        original()

    monkeypatch.setattr(engine.runtime, "start", fail_adoption)
    result = wait(client, start(client, activate_on_success=True))
    assert result["status"] == "failed" and result["error"]["stage"] == "adopt"
    assert len(client.get("/api/timelines").json()["timelines"]) == 1
    assert client.get("/app/api/posts").json()["ordering"] == "chronological"
    assert engine.storage.setting("transition") is None


def test_adoption_checkpoint_failure_restarts_live_application(client, monkeypatch):
    engine = client.app.state.engine
    original = engine.storage.snapshot
    attempts = []

    def fail_second_snapshot(*args, **kwargs):
        attempts.append(True)
        if len(attempts) == 2:
            raise OSError("injected disk failure")
        return original(*args, **kwargs)

    monkeypatch.setattr(engine.storage, "snapshot", fail_second_snapshot)
    result = wait(client, start(client, activate_on_success=True))
    assert result["status"] == "failed" and result["error"]["stage"] == "adopt"
    assert engine.runtime.running
    assert client.get("/app/api/posts").json()["ordering"] == "chronological"
    assert len(client.get("/api/timelines").json()["timelines"]) == 1


def test_poll_and_cancel_remain_responsive_during_activation(client, monkeypatch):
    engine = client.app.state.engine
    original = engine.runtime.start
    attempts = []
    entered = threading.Event()
    release = threading.Event()

    def delayed_activation():
        attempts.append(True)
        if len(attempts) == 2:
            entered.set()
            assert release.wait(10)
        original()

    monkeypatch.setattr(engine.runtime, "start", delayed_activation)
    generation_id = start(client, activate_on_success=True)
    try:
        assert entered.wait(10)
        started = time.monotonic()
        assert client.get("/api/generations/" + generation_id).status_code == 200
        assert client.post(f"/api/generations/{generation_id}/cancel").json()["status"] == "cancelled"
        assert time.monotonic() - started < 1
    finally:
        release.set()
    assert client.get("/app/api/posts").json()["ordering"] == "chronological"
    assert len(client.get("/api/timelines").json()["timelines"]) == 1


def test_failed_rollback_requests_restart_and_restart_recovers(configured, monkeypatch):
    with TestClient(create_app(**configured)) as connection:
        engine = connection.app.state.engine
        original = engine.runtime.start
        attempts = []

        def fail_adoption_and_rollback():
            attempts.append(True)
            if len(attempts) in {2, 3}:
                raise RuntimeError("injected repeated startup failure")
            original()

        monkeypatch.setattr(engine.runtime, "start", fail_adoption_and_rollback)
        result = wait(connection, start(connection, activate_on_success=True))
        assert result["status"] == "failed"
        assert "restart engine" in result["error"]["message"]
        assert engine.storage.setting("transition")
    with TestClient(create_app(**configured)) as connection:
        assert connection.get("/app/api/posts").json()["ordering"] == "chronological"
        assert len(connection.get("/api/timelines").json()["timelines"]) == 1


def test_generation_records_survive_restart(configured):
    with TestClient(create_app(**configured)) as connection:
        generation_id = start(connection)
        assert wait(connection, generation_id)["status"] == "succeeded"
    with TestClient(create_app(**configured)) as connection:
        assert connection.get("/api/generations/" + generation_id).json()["status"] == "succeeded"
        assert connection.get("/api/generations").json()["generations"][0]["id"] == generation_id


def test_bearer_auth_is_mutation_only_and_cors_errors_are_readable(configured, monkeypatch):
    monkeypatch.setenv("PARADOX_TOKEN", "test-only-token")
    monkeypatch.setenv("PARADOX_CORS_ORIGINS", "https://fork.test")
    with TestClient(create_app(**configured)) as connection:
        assert connection.get("/api/timelines").status_code == 200
        denied = connection.post("/api/timelines/sprout", headers={"origin": "https://fork.test"}, json={"modification": "none"})
        assert denied.status_code == 401
        assert denied.headers["access-control-allow-origin"] == "https://fork.test"
        accepted = connection.post("/api/timelines/sprout", headers={"authorization": "Bearer test-only-token"}, json={"modification": "none"})
        assert accepted.status_code == 201
        assert connection.post("/app/api/posts", json={"content": "iframe traffic"}).status_code == 201


@pytest.mark.parametrize("origins", ["*", "https://*.example.com", "https://fork.test/path"])
def test_cors_requires_exact_origins(monkeypatch, origins):
    monkeypatch.setenv("PARADOX_CORS_ORIGINS", origins)
    with pytest.raises(ValueError, match="exact"):
        create_app()


def test_launcher_rejects_public_binding_without_token(monkeypatch):
    environment = os.environ.copy()
    environment.pop("PARADOX_TOKEN", None)
    result = subprocess.run([sys.executable, "-m", "engine", "--host", "0.0.0.0"], env=environment, capture_output=True, text=True, timeout=10)
    assert result.returncode != 0 and "PARADOX_TOKEN" in result.stderr


def test_subprocess_scrubs_secrets_and_enforces_timeout(tmp_path, monkeypatch):
    monkeypatch.setenv("PARADOX_TOKEN", "never-in-child")
    monkeypatch.setenv("FACTORY_API_KEY", "provider-only-test-key")
    assert "PARADOX_TOKEN" not in scrubbed_environment("droid")
    assert "FACTORY_API_KEY" not in scrubbed_environment()
    assert scrubbed_environment("droid")["FACTORY_API_KEY"] == "provider-only-test-key"
    control = JobControl()
    with pytest.raises(TimeoutError):
        control.run([sys.executable, "-c", "import time; time.sleep(10)"], tmp_path, tmp_path / "process.log", .1)
    assert not control.processes


def test_droid_python_adapter_protocol_is_not_cli_only(tmp_path, monkeypatch):
    if not shutil.which("node"):
        pytest.skip("Node.js not installed")
    adapter = tmp_path / "adapter.js"
    adapter.write_text("if(process.env.PARADOX_TOKEN)process.exit(8);process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',exit_code:0,session_id:'sdk-session',summary:'SDK result',usage:{input_tokens:12,output_tokens:3,factory_credits:0.1}})));\n")
    monkeypatch.setattr(providers, "ADAPTER", adapter)
    monkeypatch.setattr(providers.droid_sandbox, "prepare", lambda code, command, environment: (command, environment))
    monkeypatch.setenv("FACTORY_API_KEY", "test-only-factory-key")
    monkeypatch.setenv("PARADOX_TOKEN", "not-forwarded")
    result = Providers().run("droid", "prompt", tmp_path, JobControl(), tmp_path / "agent.log")
    assert result["session_id"] == "sdk-session" and result["usage"]["factory_credits"] == .1


def test_guard_rejects_symlinks_oversized_files_and_too_many_edits(tmp_path):
    (tmp_path / "demo_app").mkdir()
    (tmp_path / "demo_app/link").symlink_to(tmp_path / "outside")
    with pytest.raises(ValueError, match="Symlinks"):
        files(tmp_path)
    (tmp_path / "demo_app/link").unlink()
    (tmp_path / "demo_app/large").write_bytes(b"a" * (256 * 1024 + 1))
    with pytest.raises(ValueError, match="256 KB"):
        files(tmp_path)
    current = {f"demo_app/{index}.py": b"pass" for index in range(51)}
    changed, unused_patch = changes({}, current)
    with pytest.raises(ValueError, match="50"):
        guard({}, current, changed)


def test_validation_state_is_not_the_adopted_state(client):
    recipes = client.app.state.generations.providers.recipes
    test_code = "from pathlib import Path\nimport sqlite3\ndef test_changes_scratch_state():\n    state=Path(__file__).parents[2].parent/'state'/'app.sqlite3'\n    with sqlite3.connect(state) as db:\n        db.execute(\"INSERT INTO posts VALUES (999,'validation-only',0,'2026-04-01')\")\n"
    (recipes / "state.json").write_text(json.dumps({"match": "scratch state", "files": {"demo_app/tests/test_state.py": test_code}}))
    result = wait(client, start(client, "scratch state"))
    assert result["status"] == "succeeded", result
    engine = client.app.state.engine
    snapshot = engine.storage.timeline(result["timeline_id"])["snapshot_id"]
    with sqlite3.connect(engine.storage.snapshots / snapshot / "state/app.sqlite3") as database:
        assert database.execute("SELECT 1 FROM posts WHERE id=999").fetchone() is None
