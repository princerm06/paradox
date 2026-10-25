from dataclasses import replace
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace

import pytest

from engine.adapters.base import DEMO_PROFILE
from engine.jobs import Cancelled, JobControl
from engine.project_analysis import inspect_project
from engine.providers import Providers
from engine.validation import baseline_test_count, changes, compile_command, files, guard, pytest_command, validate_runtime, validation_run


PROFILE = replace(DEMO_PROFILE, adapter='fastapi-sqlite-v1', app='notes_app.main:app',
                  compile_paths=('notes_app',), tests='tests', health_path='/health', smoke_paths=('/health',),
                  editable_prefixes=('',), immutable_paths=('requirements*.txt', 'Pipfile*', 'setup.py', 'pyproject.toml'),
                  protected_tests_prefix='tests/', sqlite_state_globs=('**/*.sqlite3',), execution='sandboxed',
                  providers=('scripted',))
RECIPES = Path(__file__).parent / 'fixtures/scripted_agent'


@pytest.fixture
def fixture_builder():
    location = Path(__file__).parent / 'fixtures/projects/build.py'
    spec = importlib.util.spec_from_file_location('paradox_notes_fixture', location)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.build_notes_repo


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    monkeypatch.delenv('FACTORY_API_KEY', raising=False)


def fingerprint(root):
    return {str(path.relative_to(root)): (path.stat().st_mtime_ns, hashlib.sha256(path.read_bytes()).hexdigest())
            for path in root.rglob('*') if path.is_file()}


def test_fixture_is_supported_without_importing_it(tmp_path, fixture_builder):
    root = fixture_builder(tmp_path)
    before = fingerprint(root)
    tracked = ['notes_app/__init__.py', 'notes_app/main.py', 'notes_app/ranking.py',
               'tests/conftest.py', 'tests/test_notes.py', 'requirements.txt']
    result = inspect_project(root, tracked)
    assert result['status'] == 'supported', result
    assert result['candidates']['app'][0]['target'] == 'notes_app.main:app'
    assert any(item['env'] == 'PARADOX_APP_DIR' for item in result['candidates']['state'])
    assert fingerprint(root) == before


@pytest.mark.parametrize('prompt,expected', [('prioritize notes', 'ok'), ('broken notes', 'compile'),
                                          ('failing notes', 'tests'), ('delete notes test', 'guard'),
                                          ('change notes dependency', 'guard'), ('slow notes', 'ok')])
def test_project_recipes_only_change_private_copy(tmp_path, fixture_builder, monkeypatch, prompt, expected):
    root = fixture_builder(tmp_path)
    before = fingerprint(root)
    code = tmp_path / 'future/code'
    shutil.copytree(root, code, ignore=shutil.ignore_patterns('.git'))
    monkeypatch.setenv('PARADOX_SCRIPTED_RECIPES', str(RECIPES))
    control = SimpleNamespace(check=lambda: None, event=SimpleNamespace(wait=lambda delay: False))
    baseline = files(code)
    result = Providers().run('scripted', prompt, code, control, tmp_path / 'agent.log', PROFILE)
    current = files(code)
    changed, patch = changes(baseline, current)
    assert result['exit_code'] == 0 and changed['files'] and patch
    assert result['usage']['factory_credits'] is None
    if expected == 'guard':
        with pytest.raises(ValueError, match='immutable'):
            guard(baseline, current, changed, PROFILE)
    else:
        guard(baseline, current, changed, PROFILE)
    if expected == 'ok':
        assert current['notes_app/ranking.py'] != baseline['notes_app/ranking.py']
        assert 'tests/test_generated_priority.py' in current
    if expected == 'compile':
        import ast
        with pytest.raises(SyntaxError):
            ast.parse(current['notes_app/ranking.py'])
    assert fingerprint(root) == before


@pytest.mark.parametrize('path', ['requirements.txt', 'requirements-dev.txt', 'nested/requirements-prod.txt',
                                'Pipfile.lock', 'nested/Pipfile', 'nested/setup.py', 'nested/pyproject.toml'])
def test_immutable_basename_patterns_protect_nested_manifests(path):
    base = {path: b'original'}
    current = {path: b'changed'}
    changed, unused = changes(base, current)
    with pytest.raises(ValueError, match='immutable|protected'):
        guard(base, current, changed, PROFILE)


def test_demo_ignores_project_recipes_and_project_refuses_droid(tmp_path, monkeypatch):
    monkeypatch.setenv('PARADOX_SCRIPTED_RECIPES', str(RECIPES / 'projects'))
    code = tmp_path / 'code'
    code.mkdir()
    with pytest.raises(ValueError, match='No scripted recipe'):
        Providers().run('scripted', 'prioritize notes', code, JobControl(), tmp_path / 'agent.log', DEMO_PROFILE)
    with pytest.raises(ValueError, match='not permitted'):
        Providers().run('droid', 'prioritize notes', code, JobControl(), tmp_path / 'agent.log', PROFILE)


def test_missing_recipe_requirement_does_not_apply(tmp_path, monkeypatch):
    monkeypatch.setenv('PARADOX_SCRIPTED_RECIPES', str(RECIPES))
    code = tmp_path / 'empty'
    code.mkdir()
    with pytest.raises(ValueError, match='No scripted recipe'):
        Providers().run('scripted', 'prioritize notes', code, JobControl(), tmp_path / 'agent.log', PROFILE)
    assert not list(code.iterdir())


def test_slow_recipe_cancelled_before_any_edit(tmp_path, fixture_builder, monkeypatch):
    code = fixture_builder(tmp_path)
    before = fingerprint(code)
    monkeypatch.setenv('PARADOX_SCRIPTED_RECIPES', str(RECIPES))
    control = JobControl()
    control.cancel()
    with pytest.raises(Cancelled):
        Providers().run('scripted', 'slow notes', code, control, tmp_path / 'agent.log', PROFILE)
    assert fingerprint(code) == before


@pytest.mark.parametrize('command', [['-m', 'compileall', '-q', 'notes_app'],
                                   ['-c', 'pytest-bootstrap', '--collect-only'], ['-c', 'pytest-bootstrap', '-q']])
def test_every_imported_validation_command_is_wrapped_and_scrubbed(tmp_path, monkeypatch, command):
    for name in ('FACTORY_API_KEY', 'PARADOX_TOKEN', 'PARADOX_SHELL_TOKEN', 'ANTHROPIC_API_KEY'):
        monkeypatch.setenv(name, 'must-not-reach-validation-' + name)
    root = tmp_path / 'generation'
    code = root / 'code'
    code.mkdir(parents=True)
    report = root / 'result.xml'
    seen = []

    def prepare(base, temporary):
        assert all(name not in base for name in ('FACTORY_API_KEY', 'PARADOX_TOKEN', 'PARADOX_SHELL_TOKEN', 'ANTHROPIC_API_KEY'))
        return dict(base, HOME=str(temporary))

    def wrap(argv, writable, run_root):
        assert run_root == root and code not in writable
        assert report in writable and report.is_file()
        return ['sandbox-marker', *argv]

    helper = SimpleNamespace(wrap=wrap, environment=prepare)
    monkeypatch.setitem(sys.modules, 'engine.adapters.exec_sandbox', helper)
    import engine.adapters
    monkeypatch.setattr(engine.adapters, 'exec_sandbox', helper, raising=False)
    control = SimpleNamespace(run=lambda argv, cwd, log, timeout, environment: seen.append((argv, cwd, environment)) or 0)
    assert validation_run([sys.executable, *command], code, root, control, tmp_path / 'log', PROFILE, report) == 0
    assert seen[0][0][0] == 'sandbox-marker' and seen[0][1] == code


def test_baseline_fixture_path_stays_inside_generation_root(tmp_path, monkeypatch):
    base = tmp_path / 'private-snapshot'
    (base / 'code/tests').mkdir(parents=True)
    (base / 'code/tests/conftest.py').write_text('raise RuntimeError("must not execute in this unit test")')
    directory = tmp_path / 'generation'
    directory.mkdir()
    seen = []

    def capture(command, code, root, control, log, profile, report, state_name):
        fixture = Path(command[command.index('-c') + 2])
        assert command[1] == '-I'
        assert command[command.index('--confcutdir') + 1] == str(code)
        assert '--import-mode=append' in command
        assert directory in fixture.parents and base not in fixture.parents
        assert fixture.read_bytes() == (base / 'code/tests/conftest.py').read_bytes()
        report.write_text(json.dumps(4))
        seen.append(fixture)
        return 0

    monkeypatch.setattr('engine.validation.validation_run', capture)
    assert baseline_test_count(directory, base, object(), tmp_path / 'log', PROFILE) == 4
    assert seen


def test_no_edit_guard_remains_mandatory():
    with pytest.raises(ValueError, match='no code changes'):
        guard({}, {}, {'files': []}, PROFILE)


def test_demo_validation_commands_remain_unchanged(tmp_path):
    assert compile_command() == [sys.executable, '-m', 'compileall', '-q', *DEMO_PROFILE.compile_paths]
    command = pytest_command(tmp_path, tmp_path / 'conftest.py', '-', ['-q'])
    assert command[:2] == [sys.executable, '-c']
    assert '--confcutdir' not in command and '--import-mode=append' not in command


@pytest.mark.parametrize('collect', [False, True])
def test_isolated_pytest_tooling_cannot_be_shadowed(tmp_path, collect):
    code = tmp_path / 'code'
    tests = code / 'tests'
    tests.mkdir(parents=True)
    marker = tmp_path / 'shadow-imported'
    for name in ('pytest.py', 'compileall.py', 'threading.py', 'subprocess.py', 'xml.py'):
        (code / name).write_text('from pathlib import Path\nPath(' + repr(str(marker)) + ').touch()\nraise RuntimeError("shadow")\n')
    (tests / 'test_failure.py').write_text('def test_failure():\n    assert False, "real-test-ran"\n')
    report = tmp_path / ('collection.json' if collect else 'tests.xml')
    arguments = ['-q', '--noconftest', '-p', 'no:cacheprovider', '-c', '/dev/null', '--rootdir', str(code), 'tests']
    arguments += ['--collect-only'] if collect else ['--junitxml', str(report)]
    command = pytest_command(code, tests / 'conftest.py', report if collect else '-', arguments, PROFILE)
    environment = {'PATH': '/usr/bin:/bin', 'PYTHONPYCACHEPREFIX': str(tmp_path / 'pycache'),
                   'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1'}
    result = subprocess.run(command, cwd=code, env=environment, capture_output=True, text=True, timeout=30)
    assert result.returncode == (0 if collect else 1), result.stdout + result.stderr
    assert not marker.exists()
    assert not list(code.rglob('*.pyc'))
    if collect:
        assert json.loads(report.read_text()) == 1
    else:
        assert 'real-test-ran' in result.stdout


@pytest.mark.parametrize('valid', [False, True])
def test_isolated_compile_tooling_cannot_be_shadowed(tmp_path, valid):
    code = tmp_path / 'code'
    package = code / 'notes_app'
    package.mkdir(parents=True)
    marker = tmp_path / 'shadow-imported'
    (code / 'compileall.py').write_text('from pathlib import Path\nPath(' + repr(str(marker)) + ').touch()\n')
    (code / 'pytest.py').write_text('raise RuntimeError("shadow")\n')
    (package / 'main.py').write_text('value = 1\n' if valid else 'value = (\n')
    result = subprocess.run(compile_command(PROFILE), cwd=code,
                            env={'PATH': '/usr/bin:/bin', 'PYTHONPYCACHEPREFIX': str(tmp_path / 'pycache')},
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == (0 if valid else 1), result.stdout + result.stderr
    assert not marker.exists()
    assert not list(code.rglob('*.pyc'))
    if valid:
        assert list((tmp_path / 'pycache').rglob('*.pyc'))


def test_demo_validation_environment_never_inherits_engine_credentials(tmp_path, monkeypatch):
    for name in ('FACTORY_API_KEY', 'PARADOX_TOKEN', 'PARADOX_SHELL_TOKEN', 'ANTHROPIC_API_KEY'):
        monkeypatch.setenv(name, 'dummy-must-not-propagate')
    observed = []
    control = SimpleNamespace(run=lambda command, code, log, timeout, environment: observed.append(environment) or 0)
    validation_run([sys.executable, '-m', 'compileall', 'demo_app'], tmp_path, tmp_path,
                   control, tmp_path / 'log', DEMO_PROFILE)
    assert observed
    assert all(name not in observed[0] for name in ('FACTORY_API_KEY', 'PARADOX_TOKEN', 'PARADOX_SHELL_TOKEN', 'ANTHROPIC_API_KEY'))


def test_validation_boot_receives_profile_and_no_engine_credentials(tmp_path, monkeypatch):
    for name in ('FACTORY_API_KEY', 'PARADOX_TOKEN', 'PARADOX_SHELL_TOKEN', 'ANTHROPIC_API_KEY'):
        monkeypatch.setenv(name, 'dummy-must-not-propagate')
    code = tmp_path / 'code'
    code.mkdir()
    state = tmp_path / 'state'
    state.mkdir()
    seen = []

    class RuntimeProbe:
        url = 'http://127.0.0.1:1'

        def __init__(self, root, port, environment, control, profile):
            assert profile is PROFILE
            assert all(name not in environment for name in ('FACTORY_API_KEY', 'PARADOX_TOKEN', 'PARADOX_SHELL_TOKEN', 'ANTHROPIC_API_KEY'))
            seen.append(root)

        def start(self):
            pass

        def stop(self):
            pass

    class ClientProbe:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def get(self, url):
            assert url.endswith('/health')
            return SimpleNamespace(status_code=200)

    monkeypatch.setattr('engine.validation.Runtime', RuntimeProbe)
    monkeypatch.setattr('engine.validation.httpx.Client', ClientProbe)
    validate_runtime(tmp_path, code, state, JobControl(), tmp_path / 'validation.log', lambda *args: None, PROFILE)
    assert seen
