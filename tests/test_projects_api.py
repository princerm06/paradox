from pathlib import Path
import runpy
import time

from fastapi.testclient import TestClient
import httpx
import pytest

from engine.api import create_app


TOKEN = {"Authorization": "Bearer nonsecret-token"}
SHELL = {**TOKEN, "X-Paradox-Shell-Token": "nonsecret-shell"}


@pytest.fixture
def repository(tmp_path, monkeypatch):
    monkeypatch.setenv("PARADOX_TOKEN", "nonsecret-token")
    monkeypatch.setenv("PARADOX_SHELL_TOKEN", "nonsecret-shell")
    monkeypatch.setenv("PARADOX_AGENT", "scripted")
    monkeypatch.delenv("FACTORY_API_KEY", raising=False)
    builder = runpy.run_path(str(Path(__file__).parent / "fixtures/projects/build.py"))
    return builder["build_notes_repo"](tmp_path)


def onboard(client, repository):
    response = client.post("/api/repositories", headers=SHELL, json={"path": str(repository)})
    assert response.status_code == 201, response.text
    rid = response.json()["id"]
    response = client.post(f"/api/repositories/{rid}/validate", headers=TOKEN, json={})
    assert response.status_code == 200 and response.json()["valid"], response.text
    response = client.post(f"/api/repositories/{rid}/trust", headers=SHELL, json={})
    assert response.status_code == 200, response.text
    response = client.post("/api/projects", headers=TOKEN, json={"repository_id": rid})
    assert response.status_code == 201, response.text
    return rid, response.json()


def identity(root):
    return {str(path.relative_to(root)): (path.read_bytes(), path.stat().st_mtime_ns)
            for path in root.rglob("*") if path.is_file()}


def test_import_open_restart_trust_and_source_identity(repository, tmp_path):
    before = identity(repository)
    state = tmp_path / "engine"
    with TestClient(create_app(state_dir=state, runtime_port=0)) as client:
        assert client.get("/api/projects").status_code == 401
        rid, project = onboard(client, repository)
        pid = project["id"]
        assert project["status"] == "ready"
        prefix = f"/api/projects/{pid}"
        assert client.get(prefix + "/timelines", headers=TOKEN).status_code == 409
        response = client.post(prefix + "/open", headers=TOKEN, json={})
        assert response.status_code == 200, response.text
        preview = response.json()["runtime"]["url"]
        assert httpx.post(preview + "api/notes", json={"content": "only imported state"}, trust_env=False).status_code == 201
        assert client.get(prefix + "/agents", headers=TOKEN).json()["default"] == "scripted"
        assert client.post("/api/projects", headers=TOKEN, json={"repository_id": rid}).status_code == 409
        assert len(client.get("/api/timelines").json()["timelines"]) == 1
    with TestClient(create_app(state_dir=state, runtime_port=0)) as client:
        assert client.get(prefix, headers=TOKEN).json()["id"] == pid
        response = client.post(prefix + "/open", headers=TOKEN, json={})
        assert response.status_code == 200, response.text
        preview = response.json()["runtime"]["url"]
        assert "only imported state" in httpx.get(preview + "api/notes", trust_env=False).text
        assert client.delete(f"/api/repositories/{rid}/trust", headers=TOKEN).status_code == 403
        assert client.delete(f"/api/repositories/{rid}/trust", headers=SHELL).status_code == 204
        assert client.get(prefix, headers=TOKEN).json()["status"] == "unavailable"
        assert client.post(prefix + "/open", headers=TOKEN, json={}).status_code == 403
        assert client.get("/api/health").json()["status"] == "ok"
    assert identity(repository) == before


def test_scripted_generation_state_activation_restore_and_revoke(repository, tmp_path):
    before = identity(repository)
    with TestClient(create_app(state_dir=tmp_path / "engine", runtime_port=0)) as client:
        rid, project = onboard(client, repository)
        prefix = "/api/projects/" + project["id"]
        opened = client.post(prefix + "/open", headers=TOKEN, json={}).json()
        preview = opened["runtime"]["url"]
        original = opened["active_timeline_id"]
        for provider in (None, "droid", "claude"):
            response = client.post(prefix + "/generations", headers=TOKEN,
                                   json={"parent_id": original, "prompt": "prioritize notes", "provider": provider})
            assert response.status_code == 422, response.text
        response = client.post(prefix + "/generations", headers=TOKEN,
                               json={"parent_id": original, "prompt": "prioritize notes", "provider": "scripted"})
        assert response.status_code == 202, response.text
        gid = response.json()["id"]
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            generation = client.get(prefix + "/generations/" + gid, headers=TOKEN).json()
            if generation["status"] in ("succeeded", "failed", "cancelled"):
                break
            time.sleep(.05)
        assert generation["status"] == "succeeded", generation
        future = generation["timeline_id"]
        assert client.post(prefix + f"/timelines/{future}/activate", headers=TOKEN).status_code == 200
        assert httpx.get(preview + "health", trust_env=False).json()["ordering"] == "priority"
        assert httpx.post(preview + "api/notes", json={"content": "future only"}, trust_env=False).status_code == 201
        snapshot = client.post(prefix + f"/timelines/{future}/snapshots", headers=TOKEN).json()
        assert httpx.post(preview + "api/notes", json={"content": "later note"}, trust_env=False).status_code == 201
        assert client.post(prefix + f"/timelines/{future}/restore", headers=TOKEN,
                           json={"snapshot_id": snapshot["id"]}).status_code == 200
        assert "later note" not in httpx.get(preview + "api/notes", trust_env=False).text
        assert client.post(prefix + f"/timelines/{original}/activate", headers=TOKEN).status_code == 200
        assert "future only" not in httpx.get(preview + "api/notes", trust_env=False).text
        slow = client.post(prefix + "/generations", headers=TOKEN,
                           json={"parent_id": original, "prompt": "slow notes", "provider": "scripted"}).json()
        assert client.delete(f"/api/repositories/{rid}/trust", headers=SHELL).status_code == 204
        projects = client.app.state.projects
        record = projects.records[project["id"]]
        import sqlite3, json
        with sqlite3.connect(projects.root / record["id"] / "engine.sqlite3") as connection:
            raw = connection.execute("SELECT data FROM generations WHERE id=?", (slow["id"],)).fetchone()[0]
        cancelled = json.loads(raw)
        assert cancelled["status"] == "failed"
        assert cancelled["error"] == {"stage": "engine", "message": "trust revoked"}
        assert len(list((projects.root / record["id"] / "snapshots").glob("*.tmp"))) == 0
    assert identity(repository) == before
