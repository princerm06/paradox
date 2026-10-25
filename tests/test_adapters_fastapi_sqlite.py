import importlib.util
from pathlib import Path
import shutil

import pytest

from engine.adapters.fastapi_sqlite import ADAPTER


CONFIG = dict(adapter="fastapi-sqlite-v1", app="notes_app.main:app", tests="tests",
              health_path="/health", state_env="PARADOX_APP_DIR")


@pytest.fixture
def code(tmp_path):
    source = Path(__file__).parent / "fixtures/projects/build.py"
    spec = importlib.util.spec_from_file_location("project_fixture", source)
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    repository = builder.build_notes_repo(tmp_path)
    destination = tmp_path / "code"
    shutil.copytree(repository, destination, ignore=shutil.ignore_patterns(".git"))
    return destination


def codes(result):
    return {item["code"] for item in result.diagnostics}


def test_profile_and_static_preflight_do_not_execute(code):
    marker = code.parent / "imported"
    with (code / "notes_app/main.py").open("a") as output:
        output.write("\nraise RuntimeError('must not import')\n")
    (code / "tests/test_no_import.py").write_text("raise RuntimeError('must not collect')\n")
    before = {path.relative_to(code): (path.read_bytes(), path.stat().st_mtime_ns)
              for path in code.rglob("*") if path.is_file()}
    profile = ADAPTER.profile(CONFIG)
    result = ADAPTER.preflight(code, profile)
    assert result.ok, result.diagnostics
    assert profile.execution == "sandboxed"
    assert profile.providers == ("scripted", "droid")
    assert profile.sqlite_state_globs == ("**/*.sqlite3", "**/*.sqlite", "**/*.db")
    assert profile.compile_paths == ("notes_app",)
    assert profile.protected_tests_prefix == "tests/"
    assert not marker.exists()
    assert before == {path.relative_to(code): (path.read_bytes(), path.stat().st_mtime_ns)
                      for path in code.rglob("*") if path.is_file()}


@pytest.mark.parametrize("changes", [
    {"working_dir": "src"}, {"tests": "../tests"}, {"tests": "/tests"},
    {"tests": "."}, {"health_path": "//evil"}, {"health_path": "/health?x"},
    {"state_env": "HOME"}, {"app": "pkg:app;bad"}, {"command": "echo bad"},
])
def test_invalid_configuration(changes):
    with pytest.raises(ValueError):
        ADAPTER.profile(dict(CONFIG, **changes))


@pytest.mark.parametrize("module", ["fastapi.py", "fastapi/__init__.py", "fastapi.pyc", "fastapi.so"])
def test_shadowed_dependency_rejected_without_import(code, module):
    path = code / module
    path.parent.mkdir(exist_ok=True)
    path.write_text("raise RuntimeError('not imported')\n")
    result = ADAPTER.preflight(code, ADAPTER.profile(CONFIG))
    assert not result.ok
    assert "dependency_shadowed" in codes(result)


@pytest.mark.parametrize("requirement,expected", [
    ("paradox-nonexistent-dependency-123", "dependency_unavailable"),
    ("fastapi>=99999", "dependency_unavailable"),
    ("fastapi[all]", "dependency_unsupported"),
    ("fastapi @ https://example.invalid/package", "dependency_unsupported"),
    ("-r more.txt", "dependency_unsupported"),
])
def test_unavailable_or_unsupported_dependencies(code, requirement, expected):
    with (code / "requirements.txt").open("a") as output:
        output.write(requirement + "\n")
    result = ADAPTER.preflight(code, ADAPTER.profile(CONFIG))
    assert not result.ok
    assert expected in codes(result)


def test_find_spec_only_receives_top_level_names(code, monkeypatch):
    from engine.adapters import fastapi_sqlite
    original = fastapi_sqlite.util.find_spec
    seen = []

    def find_spec(name):
        assert "." not in name
        seen.append(name)
        return original(name)

    monkeypatch.setattr(fastapi_sqlite.util, "find_spec", find_spec)
    assert ADAPTER.preflight(code, ADAPTER.profile(CONFIG)).ok
    assert set(seen) == {"fastapi", "uvicorn", "httpx", "pytest"}


def test_project_on_engine_import_path_rejected(code, monkeypatch):
    monkeypatch.syspath_prepend(str(code))
    result = ADAPTER.preflight(code, ADAPTER.profile(CONFIG))
    assert not result.ok
    assert "preflight_unsupported" in codes(result)


def test_symlink_and_hardlink_rejected(code):
    source = code.parent / "secret"
    source.write_text("private")
    (code / "escape").symlink_to(source)
    assert not ADAPTER.preflight(code, ADAPTER.profile(CONFIG)).ok
    (code / "escape").unlink()
    import os
    os.link(source, code / "escape")
    assert not ADAPTER.preflight(code, ADAPTER.profile(CONFIG)).ok


def test_pep621_static_dependencies(code):
    (code / "requirements.txt").unlink()
    (code / "pyproject.toml").write_text(
        '[project]\ndependencies = [\n"fastapi",\n"uvicorn",\n"httpx",\n"pytest",\n]\nrequires-python = ">=3.9"\n'
    )
    assert ADAPTER.preflight(code, ADAPTER.profile(CONFIG)).ok
    with (code / "pyproject.toml").open("a") as output:
        output.write('dynamic = ["dependencies"]\n')
    assert not ADAPTER.preflight(code, ADAPTER.profile(CONFIG)).ok


def test_initialize_empty_state_only(tmp_path):
    state = tmp_path / "state"
    ADAPTER.initialize_state(state)
    assert list(state.iterdir()) == []
    (state / "keep").write_text("keep")
    with pytest.raises(ValueError):
        ADAPTER.initialize_state(state)
    assert (state / "keep").read_text() == "keep"
    (tmp_path / "link").symlink_to(state, target_is_directory=True)
    with pytest.raises(ValueError):
        ADAPTER.initialize_state(tmp_path / "link/child")


def test_missing_and_symlinked_code_fail_closed(code):
    assert not ADAPTER.preflight(code / "missing", ADAPTER.profile(CONFIG)).ok
    link = code.parent / "linked-code"
    link.symlink_to(code, target_is_directory=True)
    assert not ADAPTER.preflight(link, ADAPTER.profile(CONFIG)).ok


def test_incompatible_python_requires_rejected(code):
    (code / "pyproject.toml").write_text(
        '[project]\ndependencies = ["fastapi"]\nrequires-python = ">=999"\n'
    )
    result = ADAPTER.preflight(code, ADAPTER.profile(CONFIG))
    assert not result.ok
    assert "python_unavailable" in codes(result)


def test_unsupported_manifest_is_not_executed(code):
    (code / "setup.py").write_text("raise RuntimeError('never run setup')\n")
    result = ADAPTER.preflight(code, ADAPTER.profile(CONFIG))
    assert not result.ok
    assert "dependency_unsupported" in codes(result)
