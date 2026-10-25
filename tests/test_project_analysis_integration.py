import hashlib
import subprocess

from fastapi.testclient import TestClient
import pytest

pytest.importorskip('engine.repositories')

from engine.api import create_app
from engine import droid_sandbox


AUTH = {'Authorization': 'Bearer disposable-m1-token'}
SHELL = dict(AUTH, **{'X-Paradox-Shell-Token': 'disposable-m1-shell'})
SOURCE = '''from fastapi import FastAPI
import os, sqlite3
from pathlib import Path
raise RuntimeError("Imported project must never execute during discovery")
app = FastAPI()
database = Path(os.environ["PARADOX_APP_DIR"]) / "app.sqlite3"
def connect(): return sqlite3.connect(str(database))
@app.get("/health")
def health(): return {"status": "ok"}
'''


def snapshot(root):
    return {str(path.relative_to(root)): (path.stat().st_mtime_ns, hashlib.sha256(path.read_bytes()).hexdigest())
            for path in root.rglob('*') if path.is_file()}


def git(root, *arguments):
    subprocess.run(['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', '-C', str(root), *arguments],
                   check=True, capture_output=True, env={'PATH': '/usr/bin:/bin', 'HOME': str(root)})


@pytest.fixture
def project(tmp_path, monkeypatch):
    if droid_sandbox.availability_reason():
        pytest.skip('Real read-only Git inspection requires macOS sandbox-exec')
    monkeypatch.setenv('PARADOX_TOKEN', 'disposable-m1-token')
    monkeypatch.setenv('PARADOX_SHELL_TOKEN', 'disposable-m1-shell')
    monkeypatch.delenv('FACTORY_API_KEY', raising=False)
    monkeypatch.delenv('PARADOX_REPOSITORY_ROOTS', raising=False)
    root = tmp_path / 'project'
    root.mkdir()
    (root / 'pkg').mkdir()
    (root / 'pkg/__init__.py').write_text('')
    (root / 'pkg/main.py').write_text(SOURCE)
    (root / 'tests').mkdir()
    (root / 'tests/test_app.py').write_text('raise RuntimeError("Tests must not run during discovery")\n')
    (root / 'requirements.txt').write_text('fastapi\nuvicorn\npytest\n')
    git(root, 'init', '-b', 'main')
    git(root, 'add', '.')
    git(root, '-c', 'user.name=Disposable', '-c', 'user.email=disposable@example.invalid', 'commit', '-m', 'fixture')
    return root.resolve(), tmp_path / 'engine'


def register(client, root):
    response = client.post('/api/repositories', headers=SHELL, json={'path': str(root)})
    assert response.status_code == 201, response.text
    return response.json()['id']


def inspect(client, repository_id):
    response = client.post('/api/repositories/' + repository_id + '/inspect', headers=AUTH, json={})
    assert response.status_code == 200, response.text
    return response.json()


def validate(client, repository_id, body=None):
    return client.post('/api/repositories/' + repository_id + '/validate', headers=AUTH, json=body or {})


def test_real_register_analyze_validate_restart_reopen(project):
    root, state = project
    before = snapshot(root)
    with TestClient(create_app(state_dir=state, runtime_port=0)) as client:
        repository_id = register(client, root)
        result = inspect(client, repository_id)
        assert result['analysis']['status'] == 'supported'
        assert result['analysis']['schema'] == 'paradox.project-analysis/v1'
        assert not result['git']['dirty']
        response = validate(client, repository_id)
        assert response.status_code == 200 and response.json()['valid'], response.text
        configuration = response.json()['configuration']
        assert configuration == dict(adapter='fastapi-sqlite-v1', app='pkg.main:app', working_dir='.',
                                     tests='tests', health_path='/health', state_env='PARADOX_APP_DIR')
        assert snapshot(root) == before
    with TestClient(create_app(state_dir=state, runtime_port=0)) as client:
        entries = client.get('/api/repositories', headers=AUTH).json()['repositories']
        assert len(entries) == 1 and entries[0]['id'] == repository_id
        assert inspect(client, repository_id)['analysis'] == result['analysis']
        assert validate(client, repository_id).json()['configuration'] == configuration
        assert validate(client, repository_id).json()['valid']
    with TestClient(create_app(state_dir=state, runtime_port=0, repository_roots=[root])) as client:
        entries = client.get('/api/repositories', headers=AUTH).json()['repositories']
        assert len(entries) == 1 and entries[0]['id'] == repository_id
        assert validate(client, entries[0]['id']).json()['valid']
    assert snapshot(root) == before


def test_saved_configuration_is_revalidated_and_failed_override_not_saved(project):
    root, state = project
    with TestClient(create_app(state_dir=state, runtime_port=0)) as client:
        repository_id = register(client, root)
        saved = validate(client, repository_id).json()['configuration']
    source = SOURCE + '\n@app.get("/healthz")\ndef healthz(): return {"status": "ok"}\n'
    (root / 'pkg/main.py').write_text(source)
    before = snapshot(root)
    with TestClient(create_app(state_dir=state, runtime_port=0)) as client:
        assert len(inspect(client, repository_id)['analysis']['candidates']['health']) == 2
        result = validate(client, repository_id).json()
        assert result['valid'] and result['configuration'] == saved
        invalid = dict(saved, tests='../outside')
        assert not validate(client, repository_id, {'configuration': invalid}).json()['valid']
    with TestClient(create_app(state_dir=state, runtime_port=0)) as client:
        result = validate(client, repository_id).json()
        assert result['valid'] and result['configuration'] == saved
    assert snapshot(root) == before
    (root / 'requirements.txt').write_text('pytest\n')
    changed = snapshot(root)
    with TestClient(create_app(state_dir=state, runtime_port=0)) as client:
        assert client.get('/api/health').status_code == 200
        assert client.get('/api/repositories', headers=AUTH).json()['repositories'][0]['id'] == repository_id
        result = validate(client, repository_id).json()
        assert not result['valid']
        assert 'fastapi_dependency_missing' in {item['code'] for item in result['diagnostics']}
    assert snapshot(root) == changed


def test_missing_saved_root_keeps_identity_and_does_not_block_demo(project):
    root, state = project
    with TestClient(create_app(state_dir=state, runtime_port=0)) as client:
        repository_id = register(client, root)
    moved = root.with_name('moved-project')
    root.rename(moved)
    before = snapshot(moved)
    with TestClient(create_app(state_dir=state, runtime_port=0)) as client:
        assert client.get('/api/health').status_code == 200
        entries = client.get('/api/repositories', headers=AUTH).json()['repositories']
        assert entries[0]['id'] == repository_id and entries[0]['root'] == str(root)
        response = client.post('/api/repositories/' + repository_id + '/inspect', headers=AUTH, json={})
        assert response.status_code == 422
    assert snapshot(moved) == before


def test_corrupt_registry_fails_closed_without_overwrite(project):
    root, state = project
    with TestClient(create_app(state_dir=state, runtime_port=0)) as client:
        register(client, root)
    registry = state / 'repositories.json'
    registry.write_text('{malformed registry')
    before = snapshot(root)
    with TestClient(create_app(state_dir=state, runtime_port=0)) as client:
        assert client.get('/api/health').status_code == 200
        assert client.get('/api/repositories', headers=AUTH).json() == {'repositories': []}
        response = client.post('/api/repositories', headers=SHELL, json={'path': str(root)})
        assert response.status_code == 503
    assert registry.read_text() == '{malformed registry'
    assert snapshot(root) == before


def test_dirty_tracked_and_untracked_files_are_observed_without_writes(project):
    root, state = project
    (root / 'pkg/main.py').write_text(SOURCE + '\n# dirty tracked source\n')
    (root / 'notes.txt').write_text('Untracked local data\n')
    before = snapshot(root)
    with TestClient(create_app(state_dir=state, runtime_port=0)) as client:
        repository_id = register(client, root)
        result = inspect(client, repository_id)
        assert result['git']['dirty']
        assert result['analysis']['status'] == 'supported'
        assert 'notes.txt' not in result['files']['sample']
        response = validate(client, repository_id).json()
        assert response['valid']
        assert 'dirty_working_tree' in {item['code'] for item in response['diagnostics']}
    assert snapshot(root) == before


@pytest.mark.parametrize('kind', ['node', 'missing_dependency', 'malformed_python'])
def test_unsupported_and_incomplete_real_projects_fail_closed(project, kind):
    root, state = project
    if kind == 'node':
        git(root, 'rm', '-r', 'pkg')
        (root / 'package.json').write_text('{"scripts":{"start":"touch SHOULD_NOT_EXIST"}}')
        git(root, 'add', 'package.json')
    elif kind == 'missing_dependency':
        (root / 'requirements.txt').write_text('pytest\n')
    else:
        (root / 'pkg/main.py').write_text('from fastapi import FastAPI\napp = FastAPI(\n')
    before = snapshot(root)
    with TestClient(create_app(state_dir=state, runtime_port=0)) as client:
        repository_id = register(client, root)
        result = inspect(client, repository_id)
        assert result['analysis']['status'] != 'supported'
        response = validate(client, repository_id)
        assert response.status_code == 200 and not response.json()['valid'], response.text
    assert snapshot(root) == before


@pytest.mark.parametrize('change,expected', [({'start': 'touch SHOULD_NOT_EXIST'}, 422),
                                          ({'state_env': 'HOME'}, 422),
                                          ({'app': 'pkg.main;touch marker:app'}, 422),
                                          ({'tests': '../outside'}, 200)])
def test_malformed_configuration_cannot_execute_or_escape(project, change, expected):
    root, state = project
    before = snapshot(root)
    configuration = dict(adapter='fastapi-sqlite-v1', app='pkg.main:app', tests='tests',
                         working_dir='.', health_path='/health', state_env='PARADOX_APP_DIR')
    configuration.update(change)
    with TestClient(create_app(state_dir=state, runtime_port=0)) as client:
        repository_id = register(client, root)
        response = validate(client, repository_id, {'configuration': configuration})
        assert response.status_code == expected, response.text
        if expected == 200:
            assert not response.json()['valid']
        assert client.post('/api/repositories/' + repository_id + '/inspect', headers=AUTH).status_code == 422
    assert snapshot(root) == before
