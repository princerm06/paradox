from pathlib import Path
import py_compile
import shutil
import sys
import time

from fastapi.testclient import TestClient
import pytest

from engine.api import create_app
from engine.jobs import JobControl
from engine import validation
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


def start_popular(client):
    root = client.get("/api/timelines").json()["active_timeline_id"]
    response = client.post("/api/generations", json={"parent_id": root, "prompt": "popular", "provider": "scripted"})
    assert response.status_code == 202, response.text
    return response.json()["id"]


def require_failed_generation(client, result, stage):
    assert result["status"] == "failed", result
    assert result["error"]["stage"] == stage, result
    assert result["timeline_id"] is None
    listing = client.get("/api/timelines").json()
    assert len(listing["timelines"]) == 1
    assert listing["timelines"][0]["id"] == listing["active_timeline_id"]
    assert client.get("/app/api/posts").json()["ordering"] == "chronological"


def test_exit_zero_without_junit_cannot_hide_a_failing_test(client, monkeypatch):
    manager = client.app.state.generations
    original = manager.providers.run

    def attack(provider, prompt, code, control, log):
        result = original(provider, prompt, code, control, log)
        (code / "demo_app/tests/test_000_exit.py").write_text("import os\nos._exit(0)\n")
        (code / "demo_app/tests/test_failure.py").write_text("def test_failure():\n    assert False\n")
        return result

    monkeypatch.setattr(manager.providers, "run", attack)
    generation_id = start_popular(client)
    result = wait(client, generation_id)
    require_failed_generation(client, result, "tests")
    assert "Test report missing" in result["error"]["message"]
    assert not list((manager.root / generation_id).glob("tests-*.xml"))


def test_skip_and_removal_attempt_cannot_remove_immutable_tests(client, monkeypatch):
    manager = client.app.state.generations
    original = manager.providers.run

    def attack(provider, prompt, code, control, log):
        result = original(provider, prompt, code, control, log)
        (code / "demo_app/tests/test_skip.py").write_text("import pytest\npytest.skip('skip', allow_module_level=True)\n")
        (code / "demo_app/tests/test_feed_contract.py").unlink()
        return result

    monkeypatch.setattr(manager.providers, "run", attack)
    require_failed_generation(client, wait(client, start_popular(client)), "guard")


def test_collection_tampering_cannot_lower_the_immutable_baseline_floor(client, monkeypatch):
    manager = client.app.state.generations
    original = manager.providers.run

    def attack(provider, prompt, code, control, log):
        result = original(provider, prompt, code, control, log)
        (code / "demo_app/tests/test_000_skip.py").write_text(
            "import pytest\n"
            "original_collect = pytest.Module.collect\n"
            "def filtered_collect(self):\n"
            "    if self.path.name in {'test_feed_contract.py', 'test_persistence_contract.py', 'test_ranking_contract.py'}:\n"
            "        return []\n"
            "    return original_collect(self)\n"
            "pytest.Module.collect = filtered_collect\n"
            "pytest.skip('hide baseline collection', allow_module_level=True)\n"
        )
        return result

    monkeypatch.setattr(manager.providers, "run", attack)
    result = wait(client, start_popular(client))
    require_failed_generation(client, result, "tests")
    assert result["evaluation"]["tests"] == {"passed": 1, "failed": 0, "errors": 0}
    assert "1 executed, expected at least 18" in result["error"]["message"]


def junit(passed=0, failed=0, errors=0, skipped=0):
    cases = "<testcase/>" * passed
    cases += "<testcase><failure/></testcase>" * failed
    cases += "<testcase><error/></testcase>" * errors
    cases += "<testcase><skipped/></testcase>" * skipped
    total = passed + failed + errors + skipped
    return f'<testsuite tests="{total}" failures="{failed}" errors="{errors}" skipped="{skipped}">{cases}</testsuite>'


@pytest.mark.parametrize("vector", ["malformed", "symlink", "failed", "errors"])
def test_exit_zero_with_bad_report_cannot_pass_generation(client, monkeypatch, vector):
    original = JobControl.run

    def tamper(self, command, *args, **kwargs):
        result = original(self, command, *args, **kwargs)
        if "--junitxml" not in command:
            return result
        report = Path(command[command.index("--junitxml") + 1])
        assert report.name.startswith("tests-") and len(report.stem) == 38
        if vector == "malformed":
            report.write_text("<testsuite")
        elif vector == "symlink":
            target = report.with_suffix(".target")
            report.rename(target)
            report.symlink_to(target)
        else:
            report.write_text(junit(passed=18, failed=int(vector == "failed"), errors=int(vector == "errors")))
        return 0

    monkeypatch.setattr(JobControl, "run", tamper)
    require_failed_generation(client, wait(client, start_popular(client)), "tests")


@pytest.mark.parametrize("kind", ["missing", "symlink", "directory", "malformed", "wrong_root", "inconsistent"])
def test_report_parser_requires_regular_well_formed_consistent_junit(tmp_path, kind):
    report = tmp_path / "report.xml"
    if kind == "symlink":
        target = tmp_path / "target.xml"
        target.write_text(junit(passed=18))
        report.symlink_to(target)
    elif kind == "directory":
        report.mkdir()
    elif kind == "malformed":
        report.write_text("<testsuite")
    elif kind == "wrong_root":
        report.write_text("<anything/>")
    elif kind == "inconsistent":
        report.write_text('<testsuite tests="18" failures="0" errors="0" skipped="0"/>')
    with pytest.raises(ValueError, match="Test report"):
        validation.test_counts(report)


def test_skipped_tests_do_not_count_towards_execution_floor(tmp_path):
    report = tmp_path / "report.xml"
    report.write_text(junit(passed=1, skipped=20))
    counts = validation.test_counts(report)
    assert counts == {"passed": 1, "failed": 0, "errors": 0}
    with pytest.raises(ValueError, match="1 executed, expected at least 18"):
        validation.require_test_success(0, counts, 18)


def test_nonzero_pytest_exit_is_rejected_even_with_a_success_report(tmp_path):
    report = tmp_path / "report.xml"
    report.write_text(junit(passed=18))
    with pytest.raises(ValueError, match="tests failed"):
        validation.require_test_success(1, validation.test_counts(report), 18)
