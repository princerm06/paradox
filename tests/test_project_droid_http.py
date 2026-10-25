from pathlib import Path
from dataclasses import replace
import json
import shutil
import sqlite3
import sys
import time

from fastapi.testclient import TestClient
import pytest

from engine.api import create_app
from engine import providers
from engine.adapters.fastapi_sqlite import ADAPTER
from engine.jobs import JobControl
from test_project_generation_http import AUTH, checked, prepare_project, preview, repository, wait_generation


pytestmark = pytest.mark.skipif(sys.platform != 'darwin', reason='real macOS agent and execution sandboxes required')


@pytest.fixture
def mocked_sdk(repository, monkeypatch):
    adapter = Path(__file__).parent / 'fixtures/droid_adapter/imported.mjs'
    if not (providers.ADAPTER.is_file() and shutil.which('node')):
        pytest.skip('build the Node adapter before HTTP mocked SDK verification')
    original_which = shutil.which
    monkeypatch.setattr(providers.shutil, 'which', lambda command: original_which('node' if command == 'droid' else command))
    monkeypatch.setattr(providers, 'ADAPTER', adapter.resolve())
    monkeypatch.setenv('FACTORY_API_KEY', 'offline-imported-sdk-dummy')
    monkeypatch.setenv('PARADOX_IMPORTED_DROID_ENABLED', '1')
    yield repository


def generate(client, prefix, parent_id, prompt):
    return checked(client, 'POST', prefix + '/generations', 202, json={
        'parent_id': parent_id, 'prompt': prompt, 'provider': 'droid', 'activate_on_success': False,
    })


def agent_log(client, prefix, generation_id):
    return '\n'.join(checked(client, 'GET', prefix + '/generations/' + generation_id + '/logs',
                            params={'stream': 'agent'})['lines'])


def test_real_agent_sandbox_runs_only_mocked_sdk(mocked_sdk, tmp_path):
    source, state = mocked_sdk
    code = tmp_path / 'isolated-future' / 'code'
    shutil.copytree(source, code, ignore=shutil.ignore_patterns('.git', '*.sqlite3'))
    profile = replace(ADAPTER.profile({
        'adapter': 'fastapi-sqlite-v1', 'app': 'notes_app.main:app', 'working_dir': '.',
        'tests': 'tests', 'health_path': '/health', 'state_env': 'PARADOX_APP_DIR',
    }), providers=('scripted', 'droid'))
    log = tmp_path / 'mocked-sdk.log'
    result = providers.Providers().run('droid', 'Implement priority ordering and tests', code, JobControl(), log, profile)
    assert result['exit_code'] == 0, log.read_text()
    assert result['session_id'] == 'offline-imported-sdk-session'
    assert (code / 'tests/test_generated_ai.py').is_file()
    assert 'permission handler audit: invoked=5' in log.read_text()


def test_mocked_sdk_http_success_evidence_activation_and_restart(mocked_sdk):
    source, state = mocked_sdk
    with TestClient(create_app(state_dir=state, runtime_port=0), headers=AUTH) as client:
        project, prefix, parent_id = prepare_project(client, source)
        generation = generate(client, prefix, parent_id, 'Choose an implementation that ranks notes by priority; add a test.')
        result = wait_generation(client, prefix, generation['id'])
        assert result['status'] == 'succeeded', result
        assert result['provider'] == 'droid' and result['parent_id'] == parent_id
        assert result['agent']['session_id'] == 'offline-imported-sdk-session'
        assert result['agent']['usage']['factory_credits'] is None
        assert result['evaluation']['passed']
        assert result['evaluation']['tests'] == {'passed': 5, 'failed': 0, 'errors': 0}
        assert {entry['path'] for entry in result['changes']['files']} == {'notes_app/ranking.py', 'tests/test_generated_ai.py'}
        diff = client.get(prefix + '/generations/' + generation['id'] + '/diff')
        assert diff.status_code == 200 and 'priority' in diff.text
        logs = agent_log(client, prefix, generation['id'])
        assert 'permission handler audit: invoked=5' in logs
        assert 'protected writes denied by handler and kernel' in logs
        assert 'session closed' in logs and 'offline-imported-sdk-dummy' not in logs
        assert preview(client, prefix)['ordering'] == 'chronological'
        checked(client, 'POST', prefix + '/timelines/' + result['timeline_id'] + '/activate')
        assert preview(client, prefix)['ordering'] == 'priority'
        timeline = next(item for item in checked(client, 'GET', prefix + '/timelines')['timelines']
                        if item['id'] == result['timeline_id'])
        assert timeline['generation_id'] == generation['id'] and timeline['parent_id'] == parent_id
    with TestClient(create_app(state_dir=state, runtime_port=0), headers=AUTH) as client:
        assert checked(client, 'GET', prefix)['runtime']['status'] == 'stopped'
        checked(client, 'POST', prefix + '/open', json={})
        assert checked(client, 'GET', prefix + '/generations/' + generation['id']) == result
        assert preview(client, prefix)['ordering'] == 'priority'


@pytest.mark.parametrize(('scenario', 'stage'), [
    ('[denied]', 'agent'), ('[sdk-error]', 'agent'), ('[no-edit]', 'guard'),
    ('[compile-error]', 'compile'), ('[test-error]', 'tests'),
])
def test_mocked_sdk_http_failures_preserve_parent_and_evidence(mocked_sdk, scenario, stage):
    source, state = mocked_sdk
    with TestClient(create_app(state_dir=state, runtime_port=0), headers=AUTH) as client:
        project, prefix, parent_id = prepare_project(client, source)
        generation = generate(client, prefix, parent_id, 'Implement requested behavior ' + scenario)
        result = wait_generation(client, prefix, generation['id'])
        assert result['status'] == 'failed' and result['error']['stage'] == stage, result
        assert result['timeline_id'] is None
        timelines = checked(client, 'GET', prefix + '/timelines')
        assert len(timelines['timelines']) == 1 and timelines['active_timeline_id'] == parent_id
        assert preview(client, prefix)['ordering'] == 'chronological'
        assert 'session closed' in agent_log(client, prefix, generation['id'])


@pytest.mark.parametrize('interrupted_record', [False, True])
def test_mocked_sdk_http_cancellation_and_interrupted_restart(mocked_sdk, interrupted_record):
    source, state = mocked_sdk
    with TestClient(create_app(state_dir=state, runtime_port=0), headers=AUTH) as client:
        project, prefix, parent_id = prepare_project(client, source)
        generation = generate(client, prefix, parent_id, 'Develop a new notes feature [slow]')
        deadline = time.monotonic() + 30
        while 'waiting for cancellation' not in agent_log(client, prefix, generation['id']):
            assert time.monotonic() < deadline
            time.sleep(.05)
        result = checked(client, 'POST', prefix + '/generations/' + generation['id'] + '/cancel')
        assert result['status'] == 'cancelled'
        checked(client, 'POST', prefix + '/close', json={})
        checked(client, 'POST', prefix + '/open', json={})
        result = checked(client, 'GET', prefix + '/generations/' + generation['id'])
        assert result['status'] == 'cancelled' and result['timeline_id'] is None
        assert len(checked(client, 'GET', prefix + '/timelines')['timelines']) == 1
    if interrupted_record:
        from engine import imported_agent_sandbox
        project_root = state / 'projects' / project['id']
        code = project_root / 'generations' / generation['id'] / 'workspace' / 'code'
        profile = ADAPTER.profile({
            'adapter': 'fastapi-sqlite-v1', 'app': 'notes_app.main:app', 'working_dir': '.',
            'tests': 'tests', 'health_path': '/health', 'state_env': 'PARADOX_APP_DIR',
        })
        command, environment = imported_agent_sandbox.prepare(code, [sys.executable, '-I', '-c', 'pass'], {}, profile)
        private_home = Path(environment['HOME'])
        (private_home / '.factory/residual-session').write_text('offline sensitive SDK session sentinel')
        result.update(status='generating', error=None, finished_at=None)
        with sqlite3.connect(str(project_root / 'engine.sqlite3')) as database:
            database.execute('UPDATE generations SET data=? WHERE id=?', (json.dumps(result), generation['id']))
    with TestClient(create_app(state_dir=state, runtime_port=0), headers=AUTH) as client:
        checked(client, 'POST', prefix + '/open', json={})
        recovered = checked(client, 'GET', prefix + '/generations/' + generation['id'])
        assert recovered['timeline_id'] is None
        if interrupted_record:
            assert recovered['status'] == 'failed' and recovered['error']['stage'] == 'engine'
            assert 'restarted' in recovered['error']['message']
            assert not private_home.exists()
        else:
            assert recovered['status'] == 'cancelled'
