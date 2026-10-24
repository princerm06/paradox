import hashlib
import json
import os
import subprocess

import pytest

from engine import project_analysis
from engine.project_analysis import inspect_project


APP = '''import os
import sqlite3
from pathlib import Path
from fastapi import FastAPI
app = FastAPI()
state = Path(os.environ.get("PARADOX_APP_DIR", ".state"))
database = state / "app.sqlite3"
def connect():
    return sqlite3.connect(str(database))
@app.get("/health")
def health():
    return {"status": "ok"}
'''


def repository(root, **overrides):
    files = {'demo/__init__.py': '', 'demo/main.py': APP,
             'demo/tests/test_feed.py': 'def test_feed():\n    assert True\n',
             'requirements.txt': 'fastapi>=0.110\nuvicorn\npytest\n'}
    files.update(overrides)
    for relative, text in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return sorted(files)


def codes(result):
    return {item['code'] for item in result['diagnostics']}


def test_supported_demo_shape_and_frozen_json_schema(tmp_path):
    result = inspect_project(tmp_path, repository(tmp_path))
    assert set(result) == {'schema', 'status', 'adapter', 'runtime', 'dependencies', 'candidates', 'diagnostics'}
    assert result['schema'] == 'paradox.project-analysis/v1'
    assert result['status'] == 'supported'
    assert result['adapter'] == 'fastapi-sqlite-v1'
    assert result['runtime'] == {'language': 'python', 'framework': 'fastapi', 'python_requires': None}
    assert result['dependencies'] == [{'path': 'requirements.txt', 'kind': 'requirements'}]
    assert result['candidates'] == {
        'app': [{'target': 'demo.main:app', 'path': 'demo/main.py', 'evidence': 'FastAPI() assignment'}],
        'tests': [{'path': 'demo/tests'}], 'health': [{'path': '/health', 'source': 'demo/main.py'}],
        'state': [{'kind': 'sqlite', 'path': 'app.sqlite3', 'env': 'PARADOX_APP_DIR'}],
    }
    assert set(result['diagnostics'][0]) == {'code', 'severity', 'message', 'path'}
    assert 'runtime isolation is not proven' in result['diagnostics'][0]['message']
    assert str(tmp_path) not in json.dumps(result)


def test_two_apps_require_explicit_selection(tmp_path):
    files = repository(tmp_path, **{'demo/other.py': APP})
    result = inspect_project(tmp_path, files)
    assert result['status'] == 'requires_configuration'
    assert len(result['candidates']['app']) == 2
    assert 'app_candidates_ambiguous' in codes(result)


@pytest.mark.parametrize('replacement,code', [('', 'health_route_missing'),
                                           ('@app.get("/healthz")', 'health_path_nonstandard'),
                                           ('@app.get(path="/api/health")', 'health_path_nonstandard')])
def test_missing_and_nonstandard_health(tmp_path, replacement, code):
    result = inspect_project(tmp_path, repository(tmp_path, **{'demo/main.py': APP.replace('@app.get("/health")', replacement)}))
    assert result['status'] == 'requires_configuration'
    assert code in codes(result)
    if replacement:
        assert result['candidates']['health']


def test_health_must_be_a_get_decorator_on_a_fastapi_handle(tmp_path):
    source = APP.replace('@app.get("/health")', '@some_client.get("/health")')
    result = inspect_project(tmp_path, repository(tmp_path, **{'demo/main.py': source}))
    assert 'health_route_missing' in codes(result)


def test_hardcoded_sqlite_and_unrelated_environment_are_not_isolation(tmp_path):
    source = APP.replace('sqlite3.connect(str(database))', 'sqlite3.connect("live.db")')
    result = inspect_project(tmp_path, repository(tmp_path, **{'demo/main.py': source}))
    assert result['status'] == 'requires_configuration'
    assert result['candidates']['state'] == [{'kind': 'sqlite', 'path': 'live.db', 'env': None}]
    assert 'sqlite_state_unconfigured' in codes(result)


def test_no_sqlite_is_supported_without_state_evidence(tmp_path):
    source = APP.replace('import sqlite3', '').replace('return sqlite3.connect(str(database))', 'return None')
    result = inspect_project(tmp_path, repository(tmp_path, **{'demo/main.py': source}))
    assert result['status'] == 'supported'
    assert result['candidates']['state'] == []


def test_factory_aliases_and_argument_state_flow_are_static_candidates(tmp_path):
    source = '''from fastapi import FastAPI as Server
from sqlite3 import connect as sqlite_connect
from os import getenv
def connection(path):
    return sqlite_connect(str(path))
def create_app():
    app = Server()
    database = getenv("PARADOX_APP_DIR") + "/app.sqlite3"
    connection(database)
    @app.get("/health")
    def health(): return {}
    return app
app = create_app()
'''
    result = inspect_project(tmp_path, repository(tmp_path, **{'demo/main.py': source}))
    assert result['status'] == 'supported'
    assert result['candidates']['app'][0]['target'] == 'demo.main:app'
    assert result['candidates']['state'][0]['env'] == 'PARADOX_APP_DIR'


def test_node_project_is_explicitly_unsupported(tmp_path):
    (tmp_path / 'package.json').write_text('{"scripts":{"start":"touch SHOULD_NOT_EXIST"}}')
    result = inspect_project(tmp_path, ['package.json'])
    assert result['status'] == 'unsupported'
    assert result['adapter'] is None
    assert result['runtime']['language'] is None
    assert 'project_type_unsupported' in codes(result)
    assert not (tmp_path / 'SHOULD_NOT_EXIST').exists()


def test_only_tracked_files_are_considered_and_no_filesystem_walk(tmp_path, monkeypatch):
    files = repository(tmp_path)
    (tmp_path / 'untracked.py').write_text(APP)
    def forbidden(*args, **kwargs):
        raise AssertionError('Discovery must not walk or execute')
    monkeypatch.setattr(os, 'scandir', forbidden)
    monkeypatch.setattr(subprocess, 'run', forbidden)
    monkeypatch.setattr(subprocess, 'Popen', forbidden)
    result = inspect_project(tmp_path, files)
    assert result['status'] == 'supported'
    assert len(result['candidates']['app']) == 1


def test_source_import_setup_and_tests_are_never_executed_or_written(tmp_path):
    marker = tmp_path / 'EXECUTED'
    dangerous = 'from pathlib import Path\nPath(' + repr(str(marker)) + ').touch()\nraise RuntimeError("do not import")\n'
    files = repository(tmp_path, **{'demo/main.py': dangerous + APP, 'setup.py': dangerous,
                                    'demo/tests/test_feed.py': dangerous})
    before = {name: (hashlib.sha256((tmp_path / name).read_bytes()).hexdigest(), (tmp_path / name).stat().st_mtime_ns) for name in files}
    result = inspect_project(tmp_path, files)
    assert result['status'] == 'supported'
    assert not marker.exists()
    assert before == {name: (hashlib.sha256((tmp_path / name).read_bytes()).hexdigest(), (tmp_path / name).stat().st_mtime_ns) for name in files}
    assert not list(tmp_path.rglob('__pycache__'))


@pytest.mark.parametrize('outside', [True, False])
def test_terminal_and_parent_symlinks_are_not_followed(tmp_path, outside):
    root = tmp_path / 'repo'
    root.mkdir()
    files = repository(root)
    target = tmp_path / 'elsewhere' if outside else root / 'real'
    target.mkdir()
    (target / 'main.py').write_text(APP)
    (root / 'linked.py').symlink_to(target / 'main.py')
    (root / 'alias').symlink_to(target, target_is_directory=True)
    result = inspect_project(root, files + ['linked.py', 'alias/main.py'])
    assert result['status'] == 'requires_configuration'
    assert len(result['candidates']['app']) == 1
    assert 'unsafe_file' in codes(result)


def test_oversized_file_is_not_read(tmp_path, monkeypatch):
    files = repository(tmp_path, **{'large.py': '#' * (project_analysis.MAX_FILE_BYTES + 1)})
    original = os.read
    read_sizes = []
    def bounded(descriptor, size):
        content = original(descriptor, size)
        read_sizes.append(len(content))
        return content
    monkeypatch.setattr(os, 'read', bounded)
    result = inspect_project(tmp_path, files)
    assert result['status'] == 'requires_configuration'
    assert 'file_size_limit' in codes(result)
    assert sum(read_sizes) < project_analysis.MAX_FILE_BYTES


def test_total_read_budget_and_count_are_bounded(tmp_path, monkeypatch):
    files = repository(tmp_path, **{'zextra.py': '#' * 200})
    original = os.read
    total = []
    def bounded(descriptor, size):
        content = original(descriptor, size)
        total.append(len(content))
        return content
    monkeypatch.setattr(os, 'read', bounded)
    monkeypatch.setattr(project_analysis, 'MAX_TOTAL_BYTES', len(APP.encode()) + 25)
    result = inspect_project(tmp_path, files)
    assert 'total_size_limit' in codes(result)
    assert sum(total) <= project_analysis.MAX_TOTAL_BYTES
    monkeypatch.setattr(project_analysis, 'MAX_FILES', 2)
    assert 'file_count_limit' in codes(inspect_project(tmp_path, files))


def test_fifo_does_not_block_inspection(tmp_path):
    files = repository(tmp_path)
    os.mkfifo(tmp_path / 'pipe.py')
    result = inspect_project(tmp_path, files + ['pipe.py'])
    assert 'unsafe_file' in codes(result)
    assert result['status'] == 'requires_configuration'


def test_unsafe_missing_and_nonstrings_are_safe_diagnostics(tmp_path):
    files = repository(tmp_path)
    result = inspect_project(tmp_path, files + ['../secret.py', '/etc/passwd', 'demo/./x.py', 'missing.py', 123])
    assert {'unsafe_tracked_path', 'file_unreadable'} <= codes(result)
    assert '/etc/passwd' not in json.dumps(result)
    assert str(tmp_path) not in json.dumps(result)


def test_malformed_python_and_invalid_utf8_are_not_imported(tmp_path):
    files = repository(tmp_path, **{'demo/main.py': 'from fastapi import FastAPI\napp = FastAPI(\n'})
    result = inspect_project(tmp_path, files)
    assert result['status'] == 'requires_configuration'
    assert {'python_parse_failed', 'app_candidate_missing'} <= codes(result)
    (tmp_path / 'demo/main.py').write_bytes(APP.encode() + b'\n#\xff\n')
    assert 'source_decode_replaced' in codes(inspect_project(tmp_path, files))


@pytest.mark.parametrize('manifest,content,expected_python', [
    ('pyproject.toml', '[project]\nrequires-python = ">=3.9"\ndependencies = [\n"fastapi[standard]>=0.110",\n"uvicorn",\n]\n', '>=3.9'),
    ('pyproject.toml', '[tool.poetry.dependencies]\npython = ">=3.10"\nfastapi = "*"\n', '>=3.10'),
    ('setup.cfg', '[options]\npython_requires = >=3.9\ninstall_requires =\n    fastapi>=0.110\n    uvicorn\n', '>=3.9'),
    ('Pipfile', '[packages]\nfastapi = "*"\n', None),
])
def test_dependency_manifest_subsets(tmp_path, manifest, content, expected_python):
    files = repository(tmp_path, **{manifest: content})
    files.remove('requirements.txt')
    result = inspect_project(tmp_path, files)
    assert result['status'] == 'supported', result
    assert result['runtime']['python_requires'] == expected_python
    assert result['dependencies'][0]['path'] == manifest


def test_malformed_manifest_and_unfollowed_requirements(tmp_path):
    files = repository(tmp_path, **{'pyproject.toml': '[project]\ndependencies = [__import__("os").system("false")]\n',
                                   'setup.cfg': 'this is not ini', 'requirements.txt': '-r /outside/secret.txt\n'})
    result = inspect_project(tmp_path, files)
    assert result['status'] == 'requires_configuration'
    assert {'manifest_malformed', 'manifest_details_unavailable', 'dependency_indirection', 'fastapi_dependency_missing'} <= codes(result)
    assert '/outside/secret.txt' not in json.dumps(result)


def test_sqlalchemy_and_external_services_need_review(tmp_path):
    source = APP.replace('import sqlite3', 'from sqlalchemy import create_engine').replace('sqlite3.connect(str(database))', 'create_engine("sqlite:///local.db")')
    result = inspect_project(tmp_path, repository(tmp_path, **{'demo/main.py': source}))
    assert result['status'] == 'requires_configuration'
    assert result['candidates']['state'] == [{'kind': 'sqlite', 'path': 'local.db', 'env': None}]
    source = source.replace('"sqlite:///local.db"', '"postgresql://user:SECRET@server/db"')
    result = inspect_project(tmp_path, repository(tmp_path, **{'demo/main.py': source + '\nimport redis\n'}))
    assert result['status'] == 'requires_configuration'
    assert {'state_backend_unresolved', 'external_state_dependency'} <= codes(result)
    assert 'SECRET' not in json.dumps(result)


def test_determinism_and_no_configuration_claim(tmp_path):
    files = repository(tmp_path)
    (tmp_path / 'paradox.json').write_text('{"not": "a validated config"}')
    first = inspect_project(tmp_path, files)
    second = inspect_project(tmp_path, list(reversed(files)) + ['paradox.json'])
    assert first == second
    assert json.loads(json.dumps(first)) == first


def test_missing_root_returns_capability_error_not_absolute_exception(tmp_path):
    result = inspect_project(tmp_path / 'not-found', ['demo/main.py'])
    assert result['status'] == 'unsupported'
    assert 'project_unreadable' in codes(result)
    assert str(tmp_path) not in json.dumps(result)


def test_annotated_app_and_commented_requirements(tmp_path):
    files = repository(tmp_path, **{'demo/main.py': APP.replace('app = FastAPI()', 'app: FastAPI = FastAPI()'),
                                   'requirements.txt': 'fastapi # app framework\n'})
    assert inspect_project(tmp_path, files)['status'] == 'supported'


@pytest.mark.parametrize('remove,code', [('requirements.txt', 'fastapi_dependency_missing'),
                                      ('demo/tests/test_feed.py', 'tests_directory_missing')])
def test_missing_dependency_or_tests_need_configuration(tmp_path, remove, code):
    files = repository(tmp_path)
    files.remove(remove)
    result = inspect_project(tmp_path, files)
    assert result['status'] == 'requires_configuration'
    assert code in codes(result)


def test_tests_are_not_mistaken_for_application_entrypoints(tmp_path):
    files = repository(tmp_path, **{'demo/tests/test_feed.py': APP})
    result = inspect_project(tmp_path, files)
    assert result['status'] == 'supported'
    assert len(result['candidates']['app']) == 1


def test_files_changed_while_reading_require_retry(tmp_path, monkeypatch):
    files = repository(tmp_path)
    source = tmp_path / 'demo/main.py'
    original = os.read
    changed = False
    def racing_read(descriptor, size):
        nonlocal changed
        content = original(descriptor, size)
        if not changed and os.fstat(descriptor).st_ino == source.stat().st_ino:
            source.write_text(APP + '\n# concurrently changed\n')
            changed = True
        return content
    monkeypatch.setattr(os, 'read', racing_read)
    result = inspect_project(tmp_path, files)
    assert changed
    assert result['status'] == 'requires_configuration'
    assert 'file_changed_during_inspection' in codes(result)


def test_secret_and_configuration_files_are_never_opened(tmp_path, monkeypatch):
    files = repository(tmp_path)
    for name in ['.env', '.env.local', 'paradox.json', 'package.json']:
        (tmp_path / name).write_text('do not read secret content')
        files.append(name)
    original = os.open
    def safe_open(path, *args, **kwargs):
        assert path not in {'.env', '.env.local', 'paradox.json', 'package.json'}
        return original(path, *args, **kwargs)
    monkeypatch.setattr(os, 'open', safe_open)
    assert inspect_project(tmp_path, files)['status'] == 'supported'


def test_parent_symlink_swap_cannot_escape_after_realpath_check(tmp_path, monkeypatch):
    root = tmp_path / 'repo'
    root.mkdir()
    files = repository(root)
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'main.py').write_text(APP)
    original = os.open
    changed = False
    def racing_open(path, flags, *args, **kwargs):
        nonlocal changed
        if path == 'demo' and not changed:
            (root / 'demo').rename(root / 'preserved-demo')
            (root / 'demo').symlink_to(outside, target_is_directory=True)
            changed = True
        return original(path, flags, *args, **kwargs)
    monkeypatch.setattr(os, 'open', racing_open)
    result = inspect_project(root, files)
    assert changed
    assert result['candidates']['app'] == []
    assert 'unsafe_file' in codes(result)


def test_async_sqlite_is_recognized_without_running_async_code(tmp_path):
    files = repository(tmp_path, **{'demo/main.py': APP.replace('sqlite3', 'aiosqlite')})
    result = inspect_project(tmp_path, files)
    assert result['status'] == 'supported'
    assert result['candidates']['state'][0]['env'] == 'PARADOX_APP_DIR'


def test_pathological_assignment_graph_is_bounded(tmp_path):
    assignments = ['value0 = os.getenv("PARADOX_APP_DIR")']
    assignments.extend('value' + str(index) + ' = value' + str(index - 1) + ' + value' + str(index - 1) for index in range(1, 40))
    source = APP + '\n' + '\n'.join(assignments) + '\nsqlite3.connect(value39)\n'
    result = inspect_project(tmp_path, repository(tmp_path, **{'demo/main.py': source}))
    assert result['status'] == 'requires_configuration'
    assert 'analysis_complexity_limit' in codes(result)


def test_ast_node_budget_is_explicit(tmp_path, monkeypatch):
    monkeypatch.setattr(project_analysis, 'MAX_AST_NODES', 10)
    result = inspect_project(tmp_path, repository(tmp_path))
    assert result['status'] == 'requires_configuration'
    assert 'analysis_complexity_limit' in codes(result)


def test_duplicate_toml_dependency_arrays_are_not_reparsed(tmp_path):
    content = '[project]\ndependencies = ["fastapi"]\n' + 'dependencies = [\n' * 1000
    result = inspect_project(tmp_path, repository(tmp_path, **{'pyproject.toml': content}))
    assert result['status'] == 'requires_configuration'
    assert 'manifest_malformed' in codes(result)
