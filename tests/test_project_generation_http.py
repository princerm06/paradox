import hashlib
import importlib.util
from pathlib import Path
import sqlite3
import subprocess
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
def repository(tmp_path, monkeypatch, request):
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
    if getattr(request, 'param', None) == 'reexec_writer':
        writer = (
            'import os,pathlib,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); '
            'path=pathlib.Path(os.environ["PARADOX_APP_DIR"])/"writer-proof"; '
            'exec("while True:\\n path.write_text(str(time.monotonic_ns()))\\n time.sleep(.05)")'
        )
        main = source / 'notes_app/main.py'
        main.write_text(main.read_text() + '''
import subprocess, sys
@app.post("/replace")
async def replace():
    try:
        subprocess.Popen([sys.executable, "-I", "-c", "pass"], start_new_session=True)
    except PermissionError:
        pass
    else:
        raise RuntimeError("detached child creation was not denied")
    os.execv(sys.executable, [sys.executable, "-I", "-c", %r])
''' % writer)
        for arguments in [('add', 'notes_app/main.py'),
                          ('-c', 'user.name=Disposable', '-c', 'user.email=fixture@example.invalid',
                           'commit', '-m', 'add adversarial runtime fixture')]:
            subprocess.run(['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', '-C', str(source), *arguments],
                           env={'PATH': '/usr/bin:/bin', 'HOME': str(tmp_path)}, check=True, capture_output=True)
    with sqlite3.connect(str(source / 'notes.sqlite3')) as database:
        database.execute('CREATE TABLE source_sentinel (value TEXT NOT NULL)')
        database.execute('INSERT INTO source_sentinel VALUES (?)', ('original source database',))
    before = fingerprint(source)
    yield source, tmp_path / 'engine'
    assert fingerprint(source) == before
    with sqlite3.connect((source / 'notes.sqlite3').as_uri() + '?mode=ro&immutable=1', uri=True) as database:
        assert database.execute('SELECT value FROM source_sentinel').fetchall() == [('original source database',)]


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


def test_http_source_sqlite_unchanged_after_generation_activation_and_reopen(repository):
    source, state = repository
    before = fingerprint(source)
    with TestClient(create_app(state_dir=state, runtime_port=0), headers=AUTH) as client:
        project, prefix, parent_id = prepare_project(client, source)
        generation = start_generation(client, prefix, parent_id, 'prioritize notes')
        result = wait_generation(client, prefix, generation['id'])
        assert result['status'] == 'succeeded', result
        checked(client, 'POST', prefix + '/timelines/' + result['timeline_id'] + '/activate')
        preview(client, prefix, 'POST', json={'content': 'Managed future only', 'priority': 99})
        assert fingerprint(source) == before
    with TestClient(create_app(state_dir=state, runtime_port=0), headers=AUTH) as client:
        assert checked(client, 'GET', prefix)['runtime']['status'] == 'stopped'
        checked(client, 'POST', prefix + '/open', json={})
        notes = preview(client, prefix)
        assert notes['ordering'] == 'priority'
        assert any(note['content'] == 'Managed future only' for note in notes['notes'])
        assert fingerprint(source) == before
        with sqlite3.connect((source / 'notes.sqlite3').as_uri() + '?mode=ro&immutable=1', uri=True) as database:
            assert database.execute('SELECT value FROM source_sentinel').fetchall() == [('original source database',)]


@pytest.mark.parametrize('repository', ['reexec_writer'], indirect=True)
@pytest.mark.parametrize('transition', ['activate', 'restore'])
def test_http_timeline_transition_stops_reexec_writer(repository, transition):
    source, state = repository
    before = fingerprint(source)
    with TestClient(create_app(state_dir=state, runtime_port=0), headers=AUTH) as client:
        project, prefix, parent_id = prepare_project(client, source)
        generation = start_generation(client, prefix, parent_id, 'prioritize notes')
        result = wait_generation(client, prefix, generation['id'])
        assert result['status'] == 'succeeded', result
        checkpoint = checked(client, 'POST', prefix + '/timelines/' + parent_id + '/snapshots', 201)
        preview(client, prefix, 'POST', json={'content': 'Outgoing parent only', 'priority': 100})
        runtime = client.app.state.projects.live[project['id']][0].runtime
        application_pid = runtime.sandbox_pid
        with pytest.raises(httpx.HTTPError):
            httpx.post(runtime.url + '/replace', trust_env=False, timeout=.5)
        marker = state / 'projects' / project['id'] / 'workspace/state/writer-proof'
        deadline = time.monotonic() + 5
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(.02)
        assert marker.exists(), 'Re-exec writer did not start after detached spawn was denied'
        if transition == 'activate':
            checked(client, 'POST', prefix + '/timelines/' + result['timeline_id'] + '/activate')
        else:
            checked(client, 'POST', prefix + '/timelines/' + parent_id + '/restore',
                    json={'snapshot_id': checkpoint['id']})
        process = subprocess.run(['/bin/ps', '-o', 'stat=', '-p', str(application_pid)],
                                 env={'PATH': '/usr/bin:/bin'}, capture_output=True, text=True, check=False)
        assert not process.stdout.strip(), 'Outgoing application must be reaped, not merely signalled'
        assert not marker.exists()
        time.sleep(.25)
        assert not marker.exists(), 'Outgoing writer mutated the restored future state'
        notes = preview(client, prefix)
        assert notes['ordering'] == ('priority' if transition == 'activate' else 'chronological')
        assert 'Outgoing parent only' not in {note['content'] for note in notes['notes']}
        assert fingerprint(source) == before
        assert checked(client, 'GET', '/api/health')['status'] == 'ok'


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
