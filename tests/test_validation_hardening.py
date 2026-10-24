from pathlib import Path
import py_compile
import shutil
import sys
import time

from fastapi.testclient import TestClient
import pytest

from engine.api import create_app
from engine.validation import changes, guard, reject_bytecode


ROOT = Path(__file__).resolve().parents[1]
FORCE_PASS = "def pytest_runtest_makereport(item, call):\n    if call.excinfo:\n        call.excinfo = None\n"


@pytest.mark.parametrize("path,source", [
    ("demo_app/conftest.py", FORCE_PASS),
    ("demo_app/tests/conftest.py", FORCE_PASS),
    ("demo_app/nested/conftest.py", FORCE_PASS),
    *[("demo_app/" + name, "[pytest]\naddopts = --ignore=demo_app/tests\n")
      for name in ("pytest.ini", ".pytest.ini", "tox.ini", "setup.cfg", "pyproject.toml")],
    ("demo_app/tests/test_plugin.py", "pytest_plugins = ['evil']\n"),
    ("demo_app/sitecustomize.py", "pass\n"),
    ("demo_app/usercustomize.py", "pass\n"),
    ("demo_app/inject.pth", "import evil\n"),
])
@pytest.mark.parametrize("existing", [False, True])
def test_guard_rejects_added_and_modified_validation_controls(path, source, existing):
    base = {path: b"old\n"} if existing else {}
    current = {path: source.encode()}
    changed, unused = changes(base, current)
    with pytest.raises(ValueError, match="protected|pytest_plugins"):
        guard(base, current, changed)


@pytest.mark.parametrize("artifact", ["demo_app/__pycache__", "demo_app/ranking.pyc"])
def test_guard_rejects_bytecode_even_when_file_inventory_ignores_it(tmp_path, artifact):
    path = tmp_path / artifact
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix == ".pyc":
        path.write_bytes(b"bytecode")
    else:
        path.mkdir()
    with pytest.raises(ValueError, match="bytecode/cache"):
        reject_bytecode(tmp_path)


def wait(client, generation_id):
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        result = client.get("/api/generations/" + generation_id).json()
        if result["status"] in {"failed", "cancelled", "succeeded"}:
            return result
        time.sleep(0.05)
    raise AssertionError(result)


@pytest.fixture
def client(tmp_path, monkeypatch):
    recipes = tmp_path / "recipes"
    shutil.copytree(ROOT / "tests/fixtures/scripted_agent", recipes)
    monkeypatch.setenv("PARADOX_AGENT", "scripted")
    monkeypatch.setenv("PARADOX_SCRIPTED_RECIPES", str(recipes))
    monkeypatch.delenv("FACTORY_API_KEY", raising=False)
    with TestClient(create_app(state_dir=tmp_path / "state", runtime_port=0,
                               runtime_source=ROOT / "demo_app")) as application:
        yield application


@pytest.mark.parametrize("vector", ["conftest", "config", "plugins", "bytecode", "pth"])
def test_malicious_generation_fails_guard_without_creating_timeline(client, monkeypatch, vector):
    manager = client.app.state.generations
    original = manager.providers.run

    def attack(provider, prompt, code, control, log):
        result = original(provider, prompt, code, control, log)
        payloads = {
            "conftest": ("demo_app/conftest.py", FORCE_PASS),
            "config": ("demo_app/pytest.ini", "[pytest]\naddopts = --ignore=demo_app/tests\n"),
            "plugins": ("demo_app/tests/test_hooks.py", "pytest_plugins = ['demo_app.hooks']\n"),
            "pth": ("demo_app/inject.pth", "import demo_app.hooks\n"),
        }
        if vector == "bytecode":
            malicious = code / "demo_app/ranking.py"
            saved = malicious.read_bytes()
            malicious.write_text("raise RuntimeError('unchecked hash payload executed')\n")
            planted = code / f"demo_app/__pycache__/ranking.{sys.implementation.cache_tag}.pyc"
            planted.parent.mkdir()
            py_compile.compile(str(malicious), cfile=str(planted), doraise=True,
                               invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
            malicious.write_bytes(saved)
        else:
            path, source = payloads[vector]
            (code / path).write_text(source)
        (code / "demo_app/tests/test_must_fail.py").write_text("def test_failure():\n    assert False\n")
        return result

    monkeypatch.setattr(manager.providers, "run", attack)
    before = client.get("/api/timelines").json()
    root = before["active_timeline_id"]
    posts = client.get("/app/api/posts").json()
    response = client.post("/api/generations", json={"parent_id": root, "prompt": "popular", "provider": "scripted"})
    assert response.status_code == 202, response.text
    result = wait(client, response.json()["id"])
    assert result["status"] == "failed", result
    assert result["error"]["stage"] == "guard", result
    assert result["timeline_id"] is None
    after = client.get("/api/timelines").json()
    assert after["active_timeline_id"] == root
    assert {item["id"] for item in after["timelines"]} == {root}
    assert client.get("/app/api/posts").json() == posts


def test_legitimate_scripted_popular_feed_keeps_all_baseline_fixtures(client):
    root = client.get("/api/timelines").json()["active_timeline_id"]
    response = client.post("/api/generations", json={"parent_id": root, "prompt": "popular", "provider": "scripted"})
    result = wait(client, response.json()["id"])
    assert result["status"] == "succeeded", result
    assert result["evaluation"]["tests"] == {"passed": 19, "failed": 0, "errors": 0}
    assert client.get("/api/timelines").json()["active_timeline_id"] == root
    assert client.post("/api/timelines/" + result["timeline_id"] + "/activate").status_code == 200
    assert client.get("/app/api/posts").json()["ordering"] == "popular"
