import json
import os
from pathlib import Path
import shutil
import sys
import time

from fastapi.testclient import TestClient
import httpx
import pytest

from engine.api import create_app
from engine import providers
from engine.jobs import JobControl, scrubbed_environment
from engine.providers import Providers
from engine.runtime import Runtime
from engine.service import Engine


SECRET_NAMES = ("FACTORY_API_KEY", "PARADOX_TOKEN", "PARADOX_SHELL_TOKEN", "ANTHROPIC_API_KEY")
SOURCE = Path(__file__).parent / "fixtures" / "engine_demo"
PROBE = '''
import json
import os
from pathlib import Path
Path(os.environ["PARADOX_APP_DIR"], "environment.json").write_text(
    json.dumps(sorted(os.environ))
)
'''


@pytest.fixture
def sentinel_environment(monkeypatch):
    for name in SECRET_NAMES:
        monkeypatch.setenv(name, "sentinel-not-a-real-credential")
    monkeypatch.setenv("UNRELATED_PRIVATE_VALUE", "also-not-for-the-app")
    monkeypatch.setenv("PYTHONPATH", "/untrusted/python/path")


def assert_environment(state, explicit=False):
    names = set(json.loads((state / "environment.json").read_text()))
    assert not names.intersection(SECRET_NAMES)
    assert "UNRELATED_PRIVATE_VALUE" not in names
    assert "PYTHONPATH" not in names
    assert {"PARADOX_APP_DIR", "PYTHONDONTWRITEBYTECODE", "PYTHONUNBUFFERED"} <= names
    if explicit:
        assert "APP_CUSTOM_SETTING" in names


def test_engine_live_runtime_scrubs_credentials_across_switches(tmp_path, sentinel_environment):
    source = tmp_path / "source"
    shutil.copytree(SOURCE, source)
    main = source / "main.py"
    main.write_text(main.read_text() + PROBE)
    engine = Engine(tmp_path / "engine", source, 0)
    try:
        engine.start()
        parent = engine.active_id
        assert_environment(engine.storage.workspace / "state")
        with httpx.Client(base_url=engine.runtime.url, trust_env=False) as client:
            assert client.get("/health").status_code == 200
            assert client.get("/api/posts").json()["ordering"] == "chronological"
        child = engine.sprout("Popularity", "popular_feed")
        assert_environment(engine.storage.workspace / "state")
        engine.activate(parent)
        assert_environment(engine.storage.workspace / "state")
        engine.activate(child["id"])
        assert_environment(engine.storage.workspace / "state")
        with httpx.Client(base_url=engine.runtime.url, trust_env=False) as client:
            assert client.get("/api/posts").json()["ordering"] == "popular"
    finally:
        engine.close()
    assert not engine.runtime.running


@pytest.mark.parametrize("explicit", [False, True])
def test_runtime_scrubs_default_and_explicit_environments(tmp_path, sentinel_environment, explicit):
    code = tmp_path / "workspace" / "code" / "demo_app"
    state = tmp_path / "workspace" / "state"
    code.mkdir(parents=True)
    state.mkdir()
    (code / "__init__.py").write_text("")
    (code / "main.py").write_text(PROBE + '''
from fastapi import FastAPI
app = FastAPI()
@app.get("/health")
def health():
    return {"status": "ok"}
''')
    environment = None
    if explicit:
        environment = scrubbed_environment()
        environment.update({name: os.environ[name] for name in SECRET_NAMES})
        environment.update(APP_CUSTOM_SETTING="retained", PYTHONPATH="/untrusted/python/path")
    original = dict(environment) if explicit else None
    runtime = Runtime(tmp_path, port=0, environment=environment)
    try:
        runtime.start()
        assert_environment(state, explicit)
        assert environment == original
    finally:
        runtime.stop()
    assert not runtime.running


def test_scripted_generation_validation_and_preview_are_credential_free(tmp_path, sentinel_environment, monkeypatch):
    source = tmp_path / "source"
    shutil.copytree(SOURCE, source)
    assertion = "import os\nassert not set(" + repr(SECRET_NAMES) + ").intersection(os.environ)\n"
    main = source / "main.py"
    main.write_text(main.read_text() + PROBE + assertion)
    (source / "tests").mkdir()
    (source / "tests/test_environment.py").write_text(
        assertion + "\ndef test_environment():\n    assert not set(" + repr(SECRET_NAMES) + ").intersection(os.environ)\n"
    )
    monkeypatch.setenv("PARADOX_AGENT", "scripted")
    monkeypatch.setenv("PARADOX_SCRIPTED_RECIPES", str(Path(__file__).parents[1] / "tests/fixtures/scripted_agent"))
    original_run = JobControl.run
    commands = []

    def audited_run(control, command, *arguments, **keywords):
        commands.append(command)
        guarded = [sys.executable, "-c", assertion + "import sys\nos.execv(sys.argv[1], sys.argv[1:])", *command]
        return original_run(control, guarded, *arguments, **keywords)

    monkeypatch.setattr(JobControl, "run", audited_run)
    app = create_app(state_dir=tmp_path / "engine", runtime_port=0, runtime_source=source)
    headers = {"Authorization": "Bearer " + os.environ["PARADOX_TOKEN"]}
    with TestClient(app) as client:
        parent = client.get("/api/timelines").json()["active_timeline_id"]
        assert client.get("/app/api/posts").json()["ordering"] == "chronological"
        response = client.post("/api/generations", headers=headers, json={
            "parent_id": parent, "prompt": "popular", "provider": "scripted",
        })
        assert response.status_code == 202, response.text
        generation_id = response.json()["id"]
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            record = client.get("/api/generations/" + generation_id).json()
            if record["status"] in {"succeeded", "failed", "cancelled"}:
                break
            time.sleep(0.05)
        assert record["status"] == "succeeded", record
        assert record["evaluation"]["tests"]["passed"] == 2
        assert client.get("/api/timelines").json()["active_timeline_id"] == parent
        response = client.post("/api/timelines/" + record["timeline_id"] + "/activate", headers=headers)
        assert response.status_code == 200, response.text
        assert client.get("/app/api/posts").json()["ordering"] == "popular"
        assert_environment(app.state.engine.storage.workspace / "state")
        directory = app.state.generations.root / generation_id
        assert_environment(directory / "validation-runtime/workspace/state")
    assert any("compileall" in command for command in commands)
    assert any("--collect-only" in command for command in commands)
    assert any("--junitxml" in command for command in commands)


def test_only_mock_agent_receives_factory_credential(tmp_path, sentinel_environment, monkeypatch):
    def prepare(code, command, environment):
        assert "FACTORY_API_KEY" in environment
        assert not set(SECRET_NAMES[1:]).intersection(environment)
        probe = (
            "import json,os\n"
            "assert 'FACTORY_API_KEY' in os.environ\n"
            "assert not set(" + repr(SECRET_NAMES[1:]) + ").intersection(os.environ)\n"
            "print(json.dumps({'type':'result','exit_code':0,'session_id':'mock-only','summary':None,'usage':{}}))\n"
        )
        return [sys.executable, "-c", probe], environment

    monkeypatch.setattr(providers.droid_sandbox, "prepare", prepare)
    result = Providers().run("droid", "mock credential-boundary probe", tmp_path, JobControl(), tmp_path / "agent.log")
    assert result["session_id"] == "mock-only"
    assert result["exit_code"] == 0
    assert "sentinel-not-a-real-credential" not in (tmp_path / "agent.log").read_text()


@pytest.mark.parametrize("authorization,shell", [
    ("authorization", "x-paradox-shell-token"),
    ("AuThOrIzAtIoN", "X-Paradox-Shell-Token"),
])
def test_preview_strips_engine_credentials_but_preserves_app_headers(tmp_path, sentinel_environment, authorization, shell):
    source = tmp_path / "source"
    shutil.copytree(SOURCE, source)
    main = source / "main.py"
    main.write_text(main.read_text() + '''
from fastapi import Request
@app.get("/header-presence")
def header_presence(request: Request):
    return {
        "authorization": "authorization" in request.headers,
        "shell": "x-paradox-shell-token" in request.headers,
        "cookie": "cookie" in request.headers,
        "custom": "x-app-setting" in request.headers,
    }
''')
    with TestClient(create_app(state_dir=tmp_path / "engine", runtime_port=0, runtime_source=source)) as client:
        response = client.get("/app/header-presence", headers={
            authorization: "Bearer " + os.environ["PARADOX_TOKEN"],
            shell: os.environ["PARADOX_SHELL_TOKEN"],
            "Cookie": "app-session=dummy-session",
            "X-App-Setting": "dummy-setting",
        })
        assert response.status_code == 200
        assert response.json() == {"authorization": False, "shell": False, "cookie": True, "custom": True}
