from pathlib import Path
import json
import os
import runpy
import sqlite3
import subprocess
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


def onboard(client, repository, configuration=None):
    response = client.post("/api/repositories", headers=SHELL, json={"path": str(repository)})
    assert response.status_code == 201, response.text
    rid = response.json()["id"]
    response = client.post(f"/api/repositories/{rid}/validate", headers=TOKEN,
                           json={"configuration": configuration} if configuration else {})
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
        with sqlite3.connect(projects.root / record["id"] / "engine.sqlite3") as connection:
            raw = connection.execute("SELECT data FROM generations WHERE id=?", (slow["id"],)).fetchone()[0]
        cancelled = json.loads(raw)
        assert cancelled["status"] == "failed"
        assert cancelled["error"] == {"stage": "engine", "message": "trust revoked"}
        assert len(list((projects.root / record["id"] / "snapshots").glob("*.tmp"))) == 0
    assert identity(repository) == before


def commit(repository):
    for arguments in (("add", "."), ("-c", "user.name=Disposable", "-c", "user.email=fixture@example.invalid", "commit", "-m", "probe")):
        subprocess.run(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-C", str(repository), *arguments],
                       env={"PATH": "/usr/bin:/bin", "HOME": str(repository)}, check=True, capture_output=True)


def test_hostile_import_through_real_api_remains_sandboxed(repository, tmp_path, monkeypatch):
    secret = tmp_path / "engine/nonsecret-private"
    secret.parent.mkdir()
    secret.write_text("nonsecret-private")
    main = repository / "notes_app/main.py"
    main.write_text(main.read_text() + '''
import ctypes, socket, subprocess
@app.get("/security-probe")
def security_probe():
    results = {name: name not in os.environ for name in ("FACTORY_API_KEY", "PARADOX_TOKEN", "PARADOX_SHELL_TOKEN", "ANTHROPIC_API_KEY")}
    for name, operation in {
        "engine_state": lambda: Path(%r).read_text(),
        "source_git": lambda: Path(%r).read_text(),
        "code_write": lambda: Path(__file__).write_text("no"),
        "home": lambda: Path(%r).read_text(),
        "network": lambda: socket.create_connection(("1.1.1.1",80), timeout=1),
        "dns": lambda: socket.getaddrinfo("example.com",80),
        "shell": lambda: subprocess.run(["/bin/sh","-c","true"]),
        "fork": lambda: os.fork(),
        "spawn": lambda: os.posix_spawn(__import__('sys').executable,[__import__('sys').executable,'-I','-c','pass'],os.environ),
        "detached": lambda: subprocess.Popen([__import__('sys').executable,'-I','-c','pass'], start_new_session=True),
        "engine_signal": lambda: os.kill(%d,0),
    }.items():
        try:
            operation()
        except OSError:
            results[name] = True
        else:
            results[name] = False
    library = ctypes.CDLL(None,use_errno=True)
    bootstrap = ctypes.c_uint.in_dll(library,"bootstrap_port")
    service = ctypes.c_uint()
    for name in ("com.apple.pasteboard.1", "com.apple.SecurityServer", "com.apple.coreservices.launchservicesd", "com.apple.cfprefsd.daemon"):
        results[name] = library.bootstrap_look_up(bootstrap,name.encode(),ctypes.byref(service)) == 1100
    mib = (ctypes.c_int * 3)(1,49,%d)
    size = ctypes.c_size_t(262144)
    buffer = ctypes.create_string_buffer(size.value)
    results["engine_environment"] = library.sysctl(mib,3,buffer,ctypes.byref(size),None,0) == -1
    return results
''' % (str(secret), str(repository / ".git/HEAD"), str(Path.home() / ".zshrc"), os.getpid(), os.getpid()))
    commit(repository)
    (repository / "original.sqlite3").write_bytes(b"nonsecret original database")
    before = identity(repository)
    monkeypatch.setenv("FACTORY_API_KEY", "nonsecret-factory-sentinel")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "nonsecret-anthropic-sentinel")
    with TestClient(create_app(state_dir=tmp_path / "engine", runtime_port=0)) as client:
        rid, project = onboard(client, repository)
        response = client.post("/api/projects/" + project["id"] + "/open", headers=TOKEN, json={})
        assert response.status_code == 200, response.text
        checks = httpx.get(response.json()["runtime"]["url"] + "security-probe", trust_env=False).json()
        assert checks and all(checks.values()), checks
        assert client.get("/api/health").json()["status"] == "ok"
    assert identity(repository) == before


def test_auth_origin_config_bound_revocation_and_delete(repository, tmp_path):
    main = repository / "notes_app/main.py"
    main.write_text(main.read_text() + '\n@app.get("/healthz")\ndef other_health():\n    return {"status": "ok"}\n')
    commit(repository)
    before = identity(repository)
    with TestClient(create_app(state_dir=tmp_path / "engine", runtime_port=0)) as client:
        rid, project = onboard(client, repository, {"adapter": "fastapi-sqlite-v1", "app": "notes_app.main:app", "state_env": "PARADOX_APP_DIR"})
        prefix = "/api/projects/" + project["id"]
        assert client.get(prefix).status_code == 401
        assert client.post(prefix + "/open", headers={**TOKEN, "Origin": "https://foreign.invalid"}, json={}).status_code == 403
        assert client.post(prefix + "/open", headers=TOKEN, json={}).status_code == 200
        configuration = {**project["configuration"], "health_path": "/healthz"}
        response = client.post(f"/api/repositories/{rid}/validate", headers=TOKEN, json={"configuration": configuration})
        assert response.status_code == 200 and response.json()["valid"], response.text
        assert client.get(prefix, headers=TOKEN).json()["status"] == "unavailable"
        assert client.post(prefix + "/open", headers=TOKEN, json={}).status_code == 403
        response = client.post(f"/api/repositories/{rid}/validate", headers=TOKEN, json={"configuration": project["configuration"]})
        assert response.json()["valid"]
        assert client.post(prefix + "/open", headers=TOKEN, json={}).status_code == 403
        assert client.delete(prefix, headers=TOKEN).status_code == 403
        assert client.delete(prefix, headers=SHELL).status_code == 204
        assert client.get(prefix, headers=TOKEN).status_code == 404
        assert client.get("/api/health").json()["status"] == "ok"
    assert identity(repository) == before


def test_corrupt_project_metadata_and_unavailable_sandbox_do_not_break_demo(repository, tmp_path, monkeypatch):
    state = tmp_path / "engine"
    with TestClient(create_app(state_dir=state, runtime_port=0)) as client:
        rid, project = onboard(client, repository)
    (state / "projects" / project["id"] / "project.json").write_text("not json")
    with TestClient(create_app(state_dir=state, runtime_port=0)) as client:
        assert client.get("/api/projects", headers=TOKEN).json() == {"projects": []}
        assert client.get("/api/health").json()["status"] == "ok"
        monkeypatch.setattr("engine.projects.service.exec_sandbox.availability_reason", lambda: "forced unavailable")
        response = client.post("/api/projects", headers=TOKEN, json={"repository_id": rid})
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "execution_sandbox_unavailable"
        assert client.get("/api/health").json()["status"] == "ok"


def test_configured_trust_is_explicit_and_does_not_execute_on_registration(repository, tmp_path, monkeypatch, caplog):
    invalid = tmp_path / "trust-loop"
    invalid.symlink_to(invalid)
    monkeypatch.setenv("PARADOX_TRUSTED_REPOSITORY_ROOTS", str(repository) + os.pathsep + str(invalid))
    monkeypatch.delenv("PARADOX_SHELL_TOKEN")
    state = tmp_path / "engine"
    with TestClient(create_app(state_dir=state, runtime_port=0, repository_roots=[repository])) as client:
        rid = client.get("/api/repositories", headers=TOKEN).json()["repositories"][0]["id"]
        assert client.get("/api/projects", headers=TOKEN).json() == {"projects": []}
        assert client.post(f"/api/repositories/{rid}/trust", headers=TOKEN, json={}).status_code == 403
        assert client.post(f"/api/repositories/{rid}/validate", headers=TOKEN, json={}).json()["valid"]
        result = client.post("/api/projects", headers=TOKEN, json={"repository_id": rid})
        assert result.status_code == 201, result.text
        assert result.json()["runtime"]["status"] == "stopped"
        assert client.get("/api/health").json()["status"] == "ok"
    assert "Configured trust root skipped: invalid_path" in caplog.text
    assert str(invalid) not in caplog.text


def test_only_one_project_open_and_no_cross_project_state(repository, tmp_path):
    second_parent = tmp_path / "second"
    second_parent.mkdir()
    builder = runpy.run_path(str(Path(__file__).parent / "fixtures/projects/build.py"))
    second = builder["build_notes_repo"](second_parent)
    before = identity(repository), identity(second)
    with TestClient(create_app(state_dir=tmp_path / "engine", runtime_port=0)) as client:
        unused, first = onboard(client, repository)
        first_path = "/api/projects/" + first["id"]
        first_open = client.post(first_path + "/open", headers=TOKEN, json={}).json()
        preview = first_open["runtime"]["url"]
        assert httpx.post(preview + "api/notes", json={"content": "first project only"}, trust_env=False).status_code == 201
        unused, other = onboard(client, second)
        second_path = "/api/projects/" + other["id"]
        other_open = client.post(second_path + "/open", headers=TOKEN, json={}).json()
        assert client.get(first_path, headers=TOKEN).json()["runtime"]["status"] == "stopped"
        assert "first project only" not in httpx.get(other_open["runtime"]["url"] + "api/notes", trust_env=False).text
        assert client.post(second_path + "/timelines/" + first["active_timeline_id"] + "/activate", headers=TOKEN).status_code == 404
        reopened = client.post(first_path + "/open", headers=TOKEN, json={}).json()
        assert "first project only" in httpx.get(reopened["runtime"]["url"] + "api/notes", trust_env=False).text
        assert client.get(second_path, headers=TOKEN).json()["runtime"]["status"] == "stopped"
    assert (identity(repository), identity(second)) == before


@pytest.mark.parametrize("failure", [
    "raise RuntimeError('disposable boot failure')",
    "__import__('subprocess').Popen([__import__('sys').executable,'-I','-c','pass'],start_new_session=True)",
])
def test_failed_original_boot_leaves_no_project_or_runtime(repository, tmp_path, failure):
    main = repository / "notes_app/main.py"
    main.write_text(main.read_text() + "\n" + failure + "\n")
    commit(repository)
    before = identity(repository)
    state = tmp_path / "engine"
    with TestClient(create_app(state_dir=state, runtime_port=0)) as client:
        registration = client.post("/api/repositories", headers=SHELL, json={"path": str(repository)}).json()
        rid = registration["id"]
        assert client.post(f"/api/repositories/{rid}/validate", headers=TOKEN, json={}).json()["valid"]
        assert client.post(f"/api/repositories/{rid}/trust", headers=SHELL, json={}).status_code == 200
        response = client.post("/api/projects", headers=TOKEN, json={"repository_id": rid})
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "import_rejected"
        assert "worker and subprocess applications are unsupported" in response.json()["detail"]["message"]
        assert client.get("/api/projects", headers=TOKEN).json() == {"projects": []}
        assert not list((state / "projects").iterdir())
        assert client.get("/api/health").json()["status"] == "ok"
    assert identity(repository) == before


@pytest.mark.parametrize("transition", ["close", "switch", "revoke"])
def test_single_process_reexec_writer_stops_on_transition(repository, tmp_path, transition):
    writer = (
        "import os,pathlib,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
        "path=pathlib.Path(os.environ['PARADOX_APP_DIR'])/'writer-proof'; "
        "exec(\"while True:\\n path.write_text(str(time.monotonic_ns()))\\n time.sleep(.05)\")"
    )
    main = repository / "notes_app/main.py"
    main.write_text(main.read_text() + '''
import sys, subprocess
@app.post("/replace")
async def replace():
    try:
        subprocess.Popen([sys.executable, "-I", "-c", "pass"], start_new_session=True)
    except PermissionError:
        pass
    else:
        raise RuntimeError("subprocess restriction missing")
    os.execv(sys.executable, [sys.executable, "-I", "-c", %r])
''' % writer)
    commit(repository)
    before = identity(repository)
    state = tmp_path / "engine"
    with TestClient(create_app(state_dir=state, runtime_port=0)) as client:
        rid, project = onboard(client, repository)
        prefix = "/api/projects/" + project["id"]
        opened = client.post(prefix + "/open", headers=TOKEN, json={}).json()
        runtime = client.app.state.projects.live[project["id"]][0].runtime
        application = runtime.sandbox_pid
        with pytest.raises(httpx.HTTPError):
            httpx.post(opened["runtime"]["url"] + "replace", trust_env=False, timeout=.3)
        marker = state / "projects" / project["id"] / "workspace/state/writer-proof"
        deadline = time.monotonic() + 5
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(.02)
        assert marker.exists()
        if transition == "revoke":
            response = client.delete(f"/api/repositories/{rid}/trust", headers=SHELL)
            assert response.status_code == 204, response.text
            assert client.get(prefix, headers=TOKEN).json()["status"] == "unavailable"
        elif transition == "switch":
            parent = tmp_path / "other"
            parent.mkdir()
            builder = runpy.run_path(str(Path(__file__).parent / "fixtures/projects/build.py"))
            unused, other = onboard(client, builder["build_notes_repo"](parent))
            response = client.post("/api/projects/" + other["id"] + "/open", headers=TOKEN, json={})
            assert response.status_code == 200, response.text
        else:
            response = client.post(prefix + "/close", headers=TOKEN, json={})
            assert response.status_code == 200, response.text
        record = subprocess.run(["/bin/ps", "-o", "stat=", "-p", str(application)],
                                env={"PATH": "/usr/bin:/bin"}, capture_output=True, text=True).stdout.strip()
        assert not record or record.startswith("Z")
        previous = marker.read_bytes()
        time.sleep(.2)
        assert marker.read_bytes() == previous
        assert client.get("/api/health").json()["status"] == "ok"
    assert identity(repository) == before
