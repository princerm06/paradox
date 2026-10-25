import json
import os
from pathlib import Path
import shutil

import httpx
import pytest

from engine.jobs import scrubbed_environment
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
