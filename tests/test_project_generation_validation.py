import hashlib
import importlib.util
from pathlib import Path
import shutil
import sys
import time

import httpx
import pytest

from engine.adapters.fastapi_sqlite import ADAPTER
from engine.generations import Generations
from engine.jobs import Cancelled, JobControl
from engine.providers import Providers
from engine.service import Engine
from engine.validation import (baseline_test_count, changes, compile_command, files,
                               guard, pytest_command, require_test_success,
                               test_counts as read_test_counts, validate_runtime, validation_run)


pytestmark = pytest.mark.skipif(sys.platform != 'darwin', reason='macOS execution sandbox required')
CREDENTIALS = ('FACTORY_API_KEY', 'PARADOX_TOKEN', 'PARADOX_SHELL_TOKEN', 'ANTHROPIC_API_KEY')
RECIPES = Path(__file__).parent / 'fixtures/scripted_agent'


def fingerprint(root):
    return {path.relative_to(root).as_posix(): (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns)
            for path in root.rglob('*') if path.is_file()}


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    for name in CREDENTIALS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv('PARADOX_SCRIPTED_RECIPES', str(RECIPES.resolve()))
    location = Path(__file__).parent / 'fixtures/projects/build.py'
    spec = importlib.util.spec_from_file_location('validation_notes_fixture', location)
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    source = builder.build_notes_repo(tmp_path)
    original = fingerprint(source)
    generation = (tmp_path / 'generation').resolve()
    generation.mkdir()
    base = generation / 'base'
    shutil.copytree(source, base / 'code', ignore=shutil.ignore_patterns('.git'))
    (base / 'state').mkdir()
    code = generation / 'workspace/code'
    shutil.copytree(base / 'code', code)
    profile = ADAPTER.profile({'adapter': 'fastapi-sqlite-v1', 'app': 'notes_app.main:app',
                               'tests': 'tests', 'state_env': 'PARADOX_APP_DIR'})
    preflight = ADAPTER.preflight(base / 'code', profile)
    assert preflight.ok, preflight.diagnostics
    yield source, generation, base, code, profile
    assert fingerprint(source) == original


def apply_recipe(workspace, prompt):
    source, directory, base, code, profile = workspace
    control = JobControl()
    agent = Providers().run('scripted', prompt, code, control, directory / 'agent.log', profile)
    assert agent['exit_code'] == 0
    assert agent['usage']['factory_credits'] is None
    before, after = files(base / 'code'), files(code)
    changed, patch = changes(before, after)
    assert changed['files'] and patch
    return control, before, after, changed


def run_tests(directory, base, code, profile, control):
    log = directory / 'validation.log'
    expected = baseline_test_count(directory, base, control, log, profile)
    report = directory / 'tests.xml'
    fixture = directory / 'baseline-collection/tests/conftest.py'
    command = pytest_command(code, fixture, '-', [
        '-q', '--noconftest', '-p', 'no:cacheprovider', '-c', '/dev/null',
        '--rootdir', str(code), profile.tests, '--junitxml', str(report),
    ], profile)
    result = validation_run(command, code, directory, control, log, profile, report)
    return result, read_test_counts(report), expected


def test_scripted_project_change_passes_real_sandboxed_validation(workspace):
    source, directory, base, code, profile = workspace
    control, before, after, changed = apply_recipe(workspace, 'prioritize notes')
    guard(before, after, changed, profile)
    assert validation_run(compile_command(profile), code, directory, control,
                          directory / 'validation.log', profile) == 0
    result, counts, expected = run_tests(directory, base, code, profile, control)
    require_test_success(result, counts, expected)
    assert expected == 4 and counts == {'passed': 5, 'failed': 0, 'errors': 0}
    assert files(code) == after
    assert not list(code.rglob('*.pyc'))
    assert not list((base / 'state').iterdir())
    assert 'Immutable baseline collected 4 tests' in (directory / 'validation.log').read_text()


@pytest.mark.parametrize('prompt', ['delete notes test', 'change notes dependency'])
def test_project_guard_rejects_protected_edits_before_execution(workspace, prompt):
    control, before, after, changed = apply_recipe(workspace, prompt)
    with pytest.raises(ValueError, match='immutable'):
        guard(before, after, changed, workspace[-1])
    assert not control.processes


def test_project_compile_failure_remains_a_real_failure(workspace):
    source, directory, base, code, profile = workspace
    control, before, after, changed = apply_recipe(workspace, 'broken notes')
    guard(before, after, changed, profile)
    assert validation_run(compile_command(profile), code, directory, control,
                          directory / 'validation.log', profile) != 0
    assert 'SyntaxError' in (directory / 'validation.log').read_text()
    assert files(code) == after


def test_project_test_failure_has_trustworthy_counts(workspace):
    source, directory, base, code, profile = workspace
    control, before, after, changed = apply_recipe(workspace, 'failing notes')
    guard(before, after, changed, profile)
    result, counts, expected = run_tests(directory, base, code, profile, control)
    assert expected == 4 and counts == {'passed': 4, 'failed': 1, 'errors': 0}
    with pytest.raises(ValueError, match='tests failed'):
        require_test_success(result, counts, expected)
    assert files(code) == after


def test_real_sandboxed_validation_tooling_cannot_be_shadowed(workspace):
    source, directory, base, code, profile = workspace
    control, before, after, changed = apply_recipe(workspace, 'prioritize notes')
    for name in ('pytest.py', 'compileall.py', 'json.py'):
        (code / name).write_text(
            'import os\nfrom pathlib import Path\n'
            '(Path(os.environ["PARADOX_APP_DIR"]) / "shadow-marker").touch()\n'
            'raise SystemExit(0)\n')
    current = files(code)
    changed, patch = changes(before, current)
    guard(before, current, changed, profile)
    assert validation_run(compile_command(profile), code, directory, control,
                          directory / 'validation.log', profile) == 0
    result, counts, expected = run_tests(directory, base, code, profile, control)
    require_test_success(result, counts, expected)
    assert counts == {'passed': 5, 'failed': 0, 'errors': 0}
    assert not list(directory.rglob('shadow-marker'))
    assert files(code) == current


def test_real_project_validation_children_do_not_receive_credentials(workspace, monkeypatch):
    source, directory, base, code, profile = workspace
    control, before, after, changed = apply_recipe(workspace, 'prioritize notes')
    for name in CREDENTIALS:
        monkeypatch.setenv(name, 'dummy-offline-sentinel-' + name)
    (code / 'tests/test_generated_credentials.py').write_text(
        'import os\ndef test_environment():\n    assert not set(' + repr(CREDENTIALS) + ').intersection(os.environ)\n')
    observed = []
    original_run = control.run

    def capture(*arguments, **keywords):
        environment = keywords['environment']
        assert not set(CREDENTIALS).intersection(environment)
        observed.append(arguments[0])
        return original_run(*arguments, **keywords)

    monkeypatch.setattr(control, 'run', capture)
    assert validation_run(compile_command(profile), code, directory, control,
                          directory / 'validation.log', profile) == 0
    result, counts, expected = run_tests(directory, base, code, profile, control)
    require_test_success(result, counts, expected)
    assert counts == {'passed': 6, 'failed': 0, 'errors': 0}
    assert len(observed) == 3
    assert all(command[0] == '/usr/bin/sandbox-exec' for command in observed)


def test_cancelled_project_validation_does_not_start_a_job_process(workspace):
    source, directory, base, code, profile = workspace
    control = JobControl()
    control.cancel()
    with pytest.raises(Cancelled):
        validation_run(compile_command(profile), code, directory, control, directory / 'validation.log', profile)
    assert not control.processes


def test_project_boot_and_smoke_use_sandboxed_runtime(workspace, monkeypatch):
    source, directory, base, code, profile = workspace
    control, before, after, changed = apply_recipe(workspace, 'prioritize notes')
    for name in CREDENTIALS:
        monkeypatch.setenv(name, 'dummy-offline-runtime-sentinel-' + name)
    application = code / 'notes_app/main.py'
    application.write_text(application.read_text() + '\nassert not set(' + repr(CREDENTIALS) + ').intersection(os.environ)\n')
    current = files(code)
    base_before = fingerprint(base)
    recorded = []
    duration = validate_runtime(directory, code, base / 'state', control, directory / 'validation.log',
                                lambda *check: recorded.append(check), profile)
    assert duration >= 0
    assert [check[0] for check in recorded] == ['boot', 'smoke']
    assert 'GET /health 200' in (directory / 'validation.log').read_text()
    assert files(code) == current
    assert fingerprint(base) == base_before


def test_project_boot_fails_closed_when_sandbox_is_unavailable(workspace, monkeypatch):
    source, directory, base, code, profile = workspace
    monkeypatch.setattr('engine.adapters.exec_sandbox.availability_reason', lambda: 'forced-offline-unavailable')
    monkeypatch.setattr('engine.runtime.subprocess.Popen', lambda *args, **kwargs: pytest.fail('unavailable sandbox spawned a child'))
    recorded = []
    with pytest.raises(RuntimeError, match='execution_sandbox_unavailable.*forced-offline-unavailable'):
        validate_runtime(directory, code, base / 'state', JobControl(), directory / 'validation.log',
                         lambda *check: recorded.append(check), profile)
    assert recorded == []
    assert not list((base / 'state').iterdir())


def test_project_generation_worker_adopts_and_recovers_a_real_future(workspace):
    source, directory, base, code, profile = workspace
    root = directory / 'managed-engine'
    engine = Engine(root, base / 'code', 0, profile=profile)
    engine.start()
    generations = Generations(engine)
    generations.start()
    try:
        parent_id = engine.active_id
        generation = generations.create(parent_id, 'prioritize notes', 'Priority future', 'scripted', False)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            result = generations.get(generation['id'])
            if result['status'] in {'succeeded', 'failed', 'cancelled'}:
                break
            time.sleep(0.05)
        assert result['status'] == 'succeeded', result
        assert result['evaluation']['passed']
        assert result['evaluation']['tests'] == {'passed': 5, 'failed': 0, 'errors': 0}
        assert [check['name'] for check in result['evaluation']['checks']] == ['agent', 'guard', 'compile', 'tests', 'boot', 'smoke']
        assert result['agent']['usage']['factory_credits'] is None
        assert 'note["priority"]' in generations.diff(generation['id'])
        assert any('GET /health 200' in line for line in generations.logs(generation['id'], 'validation', 200)['lines'])
        future_id = result['timeline_id']
        future = engine.view(future_id)
        assert future['generation_id'] == generation['id'] and future['parent_id'] == parent_id
        assert engine.active_id == parent_id
        with httpx.Client(base_url=engine.runtime.url, trust_env=False) as client:
            assert client.get('/api/notes').json()['ordering'] == 'chronological'
            assert client.post('/api/notes', json={'content': 'Parent late write', 'priority': 2}).status_code == 201
        with engine.gate:
            engine.activate(future_id)
        with httpx.Client(base_url=engine.runtime.url, trust_env=False) as client:
            notes = client.get('/api/notes').json()
            assert notes['ordering'] == 'priority'
            assert [note['priority'] for note in notes['notes']] == [8, 1]
            assert client.post('/api/notes', json={'content': 'Future only', 'priority': 9}).status_code == 201
        with engine.gate:
            engine.activate(parent_id)
        with httpx.Client(base_url=engine.runtime.url, trust_env=False) as client:
            original = client.get('/api/notes').json()
            assert original['ordering'] == 'chronological'
            assert 'Parent late write' in {note['content'] for note in original['notes']}
            assert 'Future only' not in {note['content'] for note in original['notes']}
        with engine.gate:
            engine.activate(future_id)
    finally:
        generations.close()
        engine.close()
    restarted = Engine(root, base / 'code', 0, profile=profile)
    restarted.start()
    recovered = Generations(restarted)
    recovered.start()
    try:
        assert restarted.active_id == future_id
        assert recovered.get(generation['id']) == result
        with httpx.Client(base_url=restarted.runtime.url, trust_env=False) as client:
            notes = client.get('/api/notes').json()
            assert 'Future only' in {note['content'] for note in notes['notes']}
            assert 'Parent late write' not in {note['content'] for note in notes['notes']}
    finally:
        recovered.close()
        restarted.close()
