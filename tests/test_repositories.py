import hashlib
import os
from pathlib import Path
import subprocess
import sys
import types

from fastapi.testclient import TestClient
import pytest

from engine.api import create_app
from engine import droid_sandbox
from engine.repositories.git import Git, RepositoryError
from engine.repositories.registry import Registry


def git(root, *args):
    return subprocess.run(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-C", str(root), *args],
                          check=True, capture_output=True, env={"PATH": "/usr/bin:/bin", "HOME": str(root)})


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "example"
    root.mkdir()
    git(root, "init", "-b", "main")
    (root / "pkg").mkdir()
    (root / "pkg/__init__.py").touch()
    (root / "pkg/main.py").write_text('from fastapi import FastAPI\nimport os, sqlite3\napp=FastAPI()\nstate=os.environ["PARADOX_APP_DIR"]\n@app.get("/health")\ndef health(): return {"status":"ok"}\n')
    (root / "tests").mkdir()
    (root / "tests/test_app.py").write_text("def test_app(): assert True\n")
    (root / "requirements.txt").write_text("fastapi\nuvicorn\npytest\n")
    git(root, "add", ".")
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture")
    return root.resolve()


def supported(root, files):
    return {"schema": "paradox.project-analysis/v1", "status": "supported", "adapter": "fastapi-sqlite-v1",
            "runtime": {"language": "python", "framework": "fastapi", "python_requires": None}, "dependencies": [],
            "candidates": {"app": [{"target": "pkg.main:app", "path": "pkg/main.py", "evidence": []}],
                           "tests": [{"path": "tests"}], "health": [{"path": "/health", "source": "pkg/main.py"}],
                           "state": [{"kind": "sqlite", "path": None, "env": "PARADOX_APP_DIR"}]}, "diagnostics": []}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PARADOX_TOKEN", "test-bearer")
    monkeypatch.setenv("PARADOX_SHELL_TOKEN", "test-shell")
    monkeypatch.delenv("FACTORY_API_KEY", raising=False)
    monkeypatch.setitem(sys.modules, "engine.project_analysis", types.SimpleNamespace(inspect_project=supported))
    with TestClient(create_app(state_dir=tmp_path / "engine", runtime_port=0)) as connection:
        yield connection


AUTH = {"Authorization": "Bearer test-bearer"}
SHELL = {**AUTH, "X-Paradox-Shell-Token": "test-shell"}


def register(client, repo):
    response = client.post("/api/repositories", json={"path": str(repo)}, headers=SHELL)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def tree(root):
    return {str(path.relative_to(root)): (path.stat().st_mtime_ns, hashlib.sha256(path.read_bytes()).hexdigest())
            for path in root.rglob("*") if path.is_file()}


def test_discovery_validation_and_forget_are_read_only(client, repo):
    before = tree(repo)
    repository_id = register(client, repo)
    response = client.post(f"/api/repositories/{repository_id}/inspect", json={}, headers=AUTH)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["git"]["branch"] == "main" and not result["git"]["dirty"]
    assert result["files"]["tracked_count"] == 4
    assert result["structure"] == [{"path": "pkg", "kind": "dir"}, {"path": "requirements.txt", "kind": "file"}, {"path": "tests", "kind": "dir"}]
    validation = client.post(f"/api/repositories/{repository_id}/validate", json={}, headers=AUTH)
    assert validation.status_code == 200 and validation.json()["valid"], validation.text
    assert validation.json()["configuration"]["state_env"] == "PARADOX_APP_DIR"
    duplicate = client.post("/api/repositories", json={"path": str(repo)}, headers=SHELL)
    assert duplicate.status_code == 409 and repository_id in duplicate.text
    assert client.delete(f"/api/repositories/{repository_id}", headers=SHELL).status_code == 204
    assert client.post(f"/api/repositories/{repository_id}/inspect", json={}, headers=AUTH).status_code == 404
    assert tree(repo) == before


@pytest.mark.parametrize("headers,expected", [({}, 401), (AUTH, 403), ({**AUTH, "X-Paradox-Shell-Token": "wrong"}, 403), ({**SHELL, "Origin": "https://evil.example"}, 403)])
def test_registration_requires_bearer_shell_and_allowed_origin(client, repo, headers, expected):
    assert client.post("/api/repositories", json={"path": str(repo)}, headers=headers).status_code == expected
    assert client.get("/api/repositories").status_code == 401


def test_no_token_or_shell_config_is_fail_closed(tmp_path, monkeypatch, repo):
    monkeypatch.delenv("PARADOX_TOKEN", raising=False)
    monkeypatch.delenv("PARADOX_SHELL_TOKEN", raising=False)
    app = create_app(state_dir=tmp_path / "state", runtime_port=0)
    with TestClient(app) as client:
        assert client.get("/api/repositories", headers=AUTH).status_code == 401
    monkeypatch.setenv("PARADOX_TOKEN", "test-bearer")
    with TestClient(create_app(state_dir=tmp_path / "state2", runtime_port=0)) as client:
        assert client.post("/api/repositories", json={"path": str(repo)}, headers=AUTH).status_code == 403


@pytest.mark.parametrize("path", ["relative", "/tmp/../tmp", "/", str(Path.home())])
def test_unsafe_paths_rejected(client, path):
    assert client.post("/api/repositories", json={"path": path}, headers=SHELL).status_code == 400


def test_invalid_nonroot_and_state_paths_rejected(client, tmp_path, repo):
    for path in (tmp_path, repo / "pkg"):
        assert client.post("/api/repositories", json={"path": str(path)}, headers=SHELL).status_code == 422
    assert client.post("/api/repositories", json={"path": str(tmp_path / "engine")}, headers=SHELL).status_code == 400


def test_dirty_detached_unborn_and_unusual_filenames(repo):
    (repo / "pkg/main.py").write_text("changed\n")
    (repo / "new space ☃.txt").write_text("new\n")
    git(repo, "add", "new space ☃.txt")
    (repo / "untracked.txt").touch()
    result, files = Git().inspect(repo)
    assert result["dirty"] and result["staged"] == result["unstaged"] == result["untracked"] == 1
    assert "new space ☃.txt" in files
    git(repo, "checkout", "--detach")
    assert Git().inspect(repo)[0]["detached"]


def test_malicious_fsmonitor_does_not_execute_or_refresh_index(repo, tmp_path):
    marker = repo / "EXECUTED"
    script = tmp_path / "monitor.sh"
    script.write_text('#!/bin/sh\ntouch "' + str(marker) + '"\n')
    script.chmod(0o700)
    git(repo, "config", "core.fsmonitor", str(script))
    git(repo, "config", "diff.external", str(script))
    before = tree(repo)
    Git().inspect(repo)
    assert not marker.exists()
    assert tree(repo) == before


def test_missing_sandbox_is_fail_closed(repo, monkeypatch):
    monkeypatch.setattr(droid_sandbox, "availability_reason", lambda: "unavailable")
    with pytest.raises(RepositoryError) as error:
        Git().inspect(repo)
    assert error.value.status == 503


def test_clean_filter_cannot_execute_repository_scripts(repo, tmp_path):
    script = tmp_path / "filter.sh"
    marker = repo / "FILTER_EXECUTED"
    script.write_text('#!/bin/sh\ntouch "' + str(marker) + '"\ncat\nexit 0\n')
    script.chmod(0o700)
    git(repo, "config", "filter.evil.clean", str(script))
    git(repo, "config", "filter.evil.required", "true")
    (repo / ".gitattributes").write_text("*.py filter=evil\n")
    (repo / "pkg/main.py").write_text("modified content\n")
    with pytest.raises(RepositoryError):
        Git().inspect(repo)
    assert not marker.exists()


def test_unborn_repository_and_untracked_files_are_inspectable(tmp_path):
    root = tmp_path / "unborn"
    root.mkdir()
    git(root, "init", "-b", "main")
    (root / "README.md").write_text("new project")
    result, tracked = Git().inspect(root.resolve())
    assert result["head"] is None and result["branch"] == "main" and not result["detached"]
    assert result["untracked"] == 1 and tracked == []


def test_unsupported_analysis_cannot_validate(client, repo, monkeypatch):
    def unsupported(root, files):
        result = supported(root, files)
        result.update(status="unsupported", adapter=None)
        return result
    monkeypatch.setitem(sys.modules, "engine.project_analysis", types.SimpleNamespace(inspect_project=unsupported))
    repository_id = register(client, repo)
    response = client.post(f"/api/repositories/{repository_id}/validate", json={}, headers=AUTH)
    assert not response.json()["valid"]


def test_analysis_error_cannot_be_overridden_by_configuration(client, repo, monkeypatch):
    def incomplete(root, files):
        result = supported(root, files)
        result["status"] = "requires_configuration"
        result["diagnostics"] = [{"code": "fastapi_dependency_missing", "severity": "error", "message": "Missing dependency", "path": None}]
        return result
    monkeypatch.setitem(sys.modules, "engine.project_analysis", types.SimpleNamespace(inspect_project=incomplete))
    repository_id = register(client, repo)
    response = client.post(f"/api/repositories/{repository_id}/validate", json={}, headers=AUTH)
    assert not response.json()["valid"]


def test_capture_enforces_streaming_output_cap():
    with pytest.raises(RepositoryError) as error:
        Git().capture([sys.executable, "-c", "import sys;sys.stdout.write('x'*(5*1024*1024))"], {"PATH": "/usr/bin:/bin"})
    assert error.value.code == "repository_too_large"


@pytest.mark.parametrize("changes", [{"tests": "../outside"}, {"working_dir": "/tmp"}, {"app": "other.main:app"}, {"health_path": "/missing"}])
def test_unsafe_or_unsupported_configuration_is_invalid(client, repo, changes):
    repository_id = register(client, repo)
    configuration = {"adapter": "fastapi-sqlite-v1", "app": "pkg.main:app", "state_env": "PARADOX_APP_DIR", **changes}
    response = client.post(f"/api/repositories/{repository_id}/validate", json={"configuration": configuration}, headers=AUTH)
    assert response.status_code == 200 and not response.json()["valid"], response.text


def test_arbitrary_commands_forbidden_and_raw_paths_not_page_routes(client, repo):
    repository_id = register(client, repo)
    response = client.post(f"/api/repositories/{repository_id}/validate", json={"configuration": {
        "adapter": "fastapi-sqlite-v1", "app": "pkg.main:app", "state_env": "PARADOX_APP_DIR", "start": "touch dangerous"}}, headers=AUTH)
    assert response.status_code == 422
    assert client.post(f"/api/repositories/{repository_id}/inspect", json={"path": str(repo)}, headers=AUTH).status_code == 422


def test_configured_roots_are_individual_repositories(tmp_path, monkeypatch, repo):
    monkeypatch.setenv("PARADOX_TOKEN", "test-bearer")
    with TestClient(create_app(state_dir=tmp_path / "state", runtime_port=0, repository_roots=[repo])) as client:
        entries = client.get("/api/repositories", headers=AUTH).json()["repositories"]
        assert len(entries) == 1 and entries[0]["source"] == "configured"
    with pytest.raises(RepositoryError):
        create_app(state_dir=tmp_path / "state2", repository_roots=[repo.parent])
