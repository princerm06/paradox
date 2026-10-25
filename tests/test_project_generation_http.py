import hashlib
import importlib.util
from pathlib import Path
import sys
import time

from fastapi.testclient import TestClient
import httpx
import pytest

from engine.api import create_app


pytestmark = pytest.mark.skipif(sys.platform != 'darwin', reason='macOS execution sandbox required')
if importlib.util.find_spec('engine.projects') is None:
    pytestmark = [pytestmark, pytest.mark.skip(reason='Pending Codex 2 project HTTP API dependency; not E2E evidence')]
AUTH = {'authorization': 'Bearer offline-project-token'}
SHELL = {**AUTH, 'x-paradox-shell-token': 'offline-project-shell'}
TERMINAL = {'succeeded', 'failed', 'cancelled'}


def fingerprint(root):
    return {path.relative_to(root).as_posix(): (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns)
            for path in root.rglob('*') if path.is_file()}


@pytest.fixture
def repository(tmp_path, monkeypatch):
    for name in ('FACTORY_API_KEY', 'ANTHROPIC_API_KEY', 'PARADOX_REPOSITORY_ROOTS', 'PARADOX_TRUSTED_REPOSITORY_ROOTS'):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv('PARADOX_TOKEN', 'offline-project-token')
    monkeypatch.setenv('PARADOX_SHELL_TOKEN', 'offline-project-shell')
    monkeypatch.setenv('PARADOX_AGENT', 'scripted')
    monkeypatch.setenv('PARADOX_SCRIPTED_RECIPES', str((Path(__file__).parent / 'fixtures/scripted_agent').resolve()))
    location = Path(__file__).parent / 'fixtures/projects/build.py'
    spec = importlib.util.spec_from_file_location('http_notes_fixture', location)
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    source = builder.build_notes_repo(tmp_path)
    before = fingerprint(source)
    yield source, tmp_path / 'engine'
    assert fingerprint(source) == before


def checked(client, method, path, status=200, **arguments):
    response = client.request(method, path, **arguments)
    assert response.status_code == status, response.text
    return response.json()


def prepare_project(client, source):
    registration = checked(client, 'POST', '/api/repositories', 201, headers=SHELL, json={'path': str(source)})
    repository_id = registration['id']
    inspection = checked(client, 'POST', '/api/repositories/' + repository_id + '/inspect', json={})
    assert inspection['analysis']['status'] == 'supported'
    validation = checked(client, 'POST', '/api/repositories/' + repository_id + '/validate', json={})
    assert validation['valid'], validation
    checked(client, 'POST', '/api/repositories/' + repository_id + '/trust', headers=SHELL, json={})
    project = checked(client, 'POST', '/api/projects', 201, json={'repository_id': repository_id})
    prefix = '/api/projects/' + project['id']
    project = checked(client, 'POST', prefix + '/open', json={})
    timelines = checked(client, 'GET', prefix + '/timelines')
    return project, prefix, timelines['active_timeline_id']


def start_generation(client, prefix, parent_id, prompt):
    return checked(client, 'POST', prefix + '/generations', 202,
                   json={'parent_id': parent_id, 'prompt': prompt, 'provider': 'scripted', 'activate_on_success': False})


def wait_generation(client, prefix, generation_id, predicate=None):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        record = checked(client, 'GET', prefix + '/generations/' + generation_id)
        ready = predicate(record) if predicate else record['status'] in TERMINAL
        if ready:
            return record
        if predicate and record['status'] in TERMINAL:
            pytest.fail('Generation ended before the expected intermediate status: ' + repr(record))
        time.sleep(0.05)
    pytest.fail('Generation did not reach the expected status: ' + repr(record))


def preview(client, prefix, method='GET', **arguments):
    project = checked(client, 'GET', prefix)
    url = project['runtime']['url']
    assert url.startswith('http://127.0.0.1:')
    with httpx.Client(trust_env=False, timeout=10) as connection:
        response = connection.request(method, url.rstrip('/') + '/api/notes', **arguments)
    assert response.status_code == (201 if method == 'POST' else 200), response.text
    return response.json()


def test_http_project_generation_evidence_and_future_state(repository):
    source, state = repository
    with TestClient(create_app(state_dir=state, runtime_port=0), headers=AUTH) as client:
        project, prefix, parent_id = prepare_project(client, source)
        assert preview(client, prefix)['ordering'] == 'chronological'
        generation = start_generation(client, prefix, parent_id, 'prioritize notes')
        result = wait_generation(client, prefix, generation['id'])
        assert result['status'] == 'succeeded', result
        assert result['parent_id'] == parent_id and result['provider'] == 'scripted'
        assert result['base_snapshot_id'] and result['finished_at'] and result['error'] is None
        assert result['agent']['exit_code'] == 0
        assert result['agent']['usage']['factory_credits'] is None
        assert result['evaluation']['passed']
        assert result['evaluation']['tests'] == {'passed': 5, 'failed': 0, 'errors': 0}
        assert [check['name'] for check in result['evaluation']['checks']] == ['agent', 'guard', 'compile', 'tests', 'boot', 'smoke']
        changed = {entry['path'] for entry in result['changes']['files']}
        assert changed == {'notes_app/ranking.py', 'tests/test_generated_priority.py'}
        diff = client.get(prefix + '/generations/' + generation['id'] + '/diff')
        assert diff.status_code == 200 and 'note["priority"]' in diff.text
        for stream, text in [('agent', 'Scripted recipe selected'), ('validation', 'GET /health 200')]:
            log = checked(client, 'GET', prefix + '/generations/' + generation['id'] + '/logs', params={'stream': stream})
            assert any(text in line for line in log['lines'])
        timelines = checked(client, 'GET', prefix + '/timelines')
        assert timelines['active_timeline_id'] == parent_id
        future = next(item for item in timelines['timelines'] if item['id'] == result['timeline_id'])
        assert future['parent_id'] == parent_id and future['generation_id'] == generation['id']
        saved_code = state / 'projects' / project['id'] / 'snapshots' / future['snapshot_id'] / 'code'
        assert (saved_code / 'notes_app/ranking.py').read_bytes() != (source / 'notes_app/ranking.py').read_bytes()
        assert (saved_code / 'tests/test_generated_priority.py').is_file()
        preview(client, prefix, 'POST', json={'content': 'Parent late write', 'priority': 2})
        checked(client, 'POST', prefix + '/timelines/' + future['id'] + '/activate')
        child_notes = preview(client, prefix)
        assert child_notes['ordering'] == 'priority'
        assert [note['priority'] for note in child_notes['notes']] == [8, 1]
        preview(client, prefix, 'POST', json={'content': 'Future only', 'priority': 9})
        checked(client, 'POST', prefix + '/timelines/' + parent_id + '/activate')
        original = preview(client, prefix)
        assert original['ordering'] == 'chronological'
        assert 'Parent late write' in {note['content'] for note in original['notes']}
        assert 'Future only' not in {note['content'] for note in original['notes']}
        checked(client, 'POST', prefix + '/timelines/' + future['id'] + '/activate')
        assert 'Future only' in {note['content'] for note in preview(client, prefix)['notes']}


@pytest.mark.parametrize('prompt,stage', [('broken notes', 'compile'), ('failing notes', 'tests'),
                                        ('delete notes test', 'guard'), ('change notes dependency', 'guard')])
def test_http_project_generation_failures_remain_inspectable(repository, prompt, stage):
    source, state = repository
    with TestClient(create_app(state_dir=state, runtime_port=0), headers=AUTH) as client:
        project, prefix, parent_id = prepare_project(client, source)
        generation = start_generation(client, prefix, parent_id, prompt)
        result = wait_generation(client, prefix, generation['id'])
        assert result['status'] == 'failed' and result['error']['stage'] == stage, result
        assert result['timeline_id'] is None and result['changes']['files']
        assert result['evaluation']['passed'] is False
        timelines = checked(client, 'GET', prefix + '/timelines')
        assert len(timelines['timelines']) == 1 and timelines['active_timeline_id'] == parent_id
        assert client.get(prefix + '/generations/' + generation['id'] + '/diff').text
        logs = checked(client, 'GET', prefix + '/generations/' + generation['id'] + '/logs', params={'stream': 'validation'})
        assert any(stage + ': failed' in line for line in logs['lines'])
        if stage == 'tests':
            assert result['evaluation']['tests'] == {'passed': 4, 'failed': 1, 'errors': 0}
        assert preview(client, prefix)['ordering'] == 'chronological'


@pytest.mark.parametrize('cancel', [False, True])
def test_http_project_slow_recipe_and_cancel(repository, cancel):
    source, state = repository
    with TestClient(create_app(state_dir=state, runtime_port=0), headers=AUTH) as client:
        project, prefix, parent_id = prepare_project(client, source)
        generation = start_generation(client, prefix, parent_id, 'slow notes')
        if cancel:
            running = wait_generation(client, prefix, generation['id'], lambda record: record['status'] == 'generating')
            assert running['timeline_id'] is None
            cancelled = checked(client, 'POST', prefix + '/generations/' + generation['id'] + '/cancel')
            assert cancelled['status'] == 'cancelled'
        result = wait_generation(client, prefix, generation['id'])
        assert result['status'] == ('cancelled' if cancel else 'succeeded'), result
        if cancel:
            checked(client, 'POST', prefix + '/close', json={})
            checked(client, 'POST', prefix + '/open', json={})
            assert len(checked(client, 'GET', prefix + '/timelines')['timelines']) == 1
            assert result['timeline_id'] is None
        else:
            assert result['evaluation']['tests']['passed'] == 5


def test_http_project_success_survives_restart_without_implicit_boot(repository):
    source, state = repository
    with TestClient(create_app(state_dir=state, runtime_port=0), headers=AUTH) as client:
        project, prefix, parent_id = prepare_project(client, source)
        generation = start_generation(client, prefix, parent_id, 'prioritize notes')
        result = wait_generation(client, prefix, generation['id'])
        assert result['status'] == 'succeeded', result
    with TestClient(create_app(state_dir=state, runtime_port=0), headers=AUTH) as client:
        durable = checked(client, 'GET', prefix)
        assert durable['runtime']['status'] == 'stopped'
        checked(client, 'POST', prefix + '/open', json={})
        restored = checked(client, 'GET', prefix + '/generations/' + generation['id'])
        assert restored == result
        assert restored['timeline_id'] in {item['id'] for item in checked(client, 'GET', prefix + '/timelines')['timelines']}


def test_http_project_shutdown_recovers_interrupted_generation(repository):
    source, state = repository
    with TestClient(create_app(state_dir=state, runtime_port=0), headers=AUTH) as client:
        project, prefix, parent_id = prepare_project(client, source)
        generation = start_generation(client, prefix, parent_id, 'slow notes')
        wait_generation(client, prefix, generation['id'], lambda record: record['status'] == 'generating')
    with TestClient(create_app(state_dir=state, runtime_port=0), headers=AUTH) as client:
        assert checked(client, 'GET', prefix)['runtime']['status'] == 'stopped'
        checked(client, 'POST', prefix + '/open', json={})
        interrupted = checked(client, 'GET', prefix + '/generations/' + generation['id'])
        assert interrupted['status'] == 'failed' and interrupted['error']['stage'] == 'engine', interrupted
        assert interrupted['timeline_id'] is None
        assert len(checked(client, 'GET', prefix + '/timelines')['timelines']) == 1
