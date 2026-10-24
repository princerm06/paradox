import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import xml.etree.ElementTree as element_tree

import pytest


ROOT = Path(__file__).resolve().parents[2]
RECIPES = ROOT / 'tests' / 'fixtures' / 'scripted_agent'
EXPECTED = {
    'popular_feed': ('popular', 0),
    'broken': ('break the app', 0),
    'failing_test': ('failing test', 0),
    'delete_test': ('delete a test', 0),
    'slow': ('slow', 5),
}


def recipe(name):
    return json.loads((RECIPES / f'{name}.json').read_text())


@pytest.fixture
def workspace(tmp_path):
    code_dir = tmp_path / 'code'
    shutil.copytree(
        ROOT / 'demo_app', code_dir / 'demo_app',
        ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.pytest_cache'),
    )
    return code_dir


def apply_recipe(code_dir, name):
    for relative_path, content in recipe(name)['files'].items():
        destination = code_dir / relative_path
        if content is None:
            destination.unlink()
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(content)


def validation_environment(tmp_path):
    return {
        'PATH': os.defpath,
        'HOME': str(tmp_path),
        'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1',
        'PYTHONDONTWRITEBYTECODE': '1',
    }


@pytest.mark.parametrize('name', sorted(EXPECTED))
def test_recipe_format_and_protected_file_targets(name):
    loaded = recipe(name)
    assert set(loaded) == {'match', 'delay_s', 'summary', 'files'}
    assert (loaded['match'], loaded['delay_s']) == EXPECTED[name]
    assert isinstance(loaded['summary'], str) and loaded['summary'].strip()
    assert loaded['files']
    for relative_path, content in loaded['files'].items():
        path = Path(relative_path)
        assert not path.is_absolute()
        assert '..' not in path.parts
        assert path.parts[0] == 'demo_app'
        assert relative_path != 'demo_app/AGENTS.md'
        assert content is None or isinstance(content, str)
        if content is not None:
            assert len(content.encode()) < 256 * 1024
        if path.parts[:2] == ('demo_app', 'tests') and (ROOT / path).exists():
            assert name == 'delete_test'
            assert relative_path == 'demo_app/tests/test_feed_contract.py'
            assert content is None


def test_all_five_frozen_recipes_are_present():
    assert {path.stem for path in RECIPES.glob('*.json')} == set(EXPECTED)


@pytest.mark.parametrize('name', ['popular_feed', 'slow', 'failing_test'])
def test_recipes_reach_expected_validation_result_without_credentials(workspace, tmp_path, name):
    base_tests = {
        path.relative_to(workspace): path.read_bytes()
        for path in (workspace / 'demo_app' / 'tests').glob('*.py')
    }
    apply_recipe(workspace, name)
    for path, original in base_tests.items():
        assert (workspace / path).read_bytes() == original
    environment = validation_environment(tmp_path)
    compile_result = subprocess.run(
        [sys.executable, '-m', 'compileall', '-q', 'demo_app'], cwd=workspace,
        env=environment, capture_output=True, text=True, timeout=15,
    )
    assert compile_result.returncode == 0, compile_result.stdout + compile_result.stderr
    report_path = tmp_path / 'tests.xml'
    result = subprocess.run(
        [sys.executable, '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-c', '/dev/null',
         '--rootdir', str(workspace), 'demo_app/tests', '--junitxml', str(report_path)],
        cwd=workspace, env=environment, capture_output=True, text=True, timeout=20,
    )
    expected_exit = 1 if name == 'failing_test' else 0
    assert result.returncode == expected_exit, result.stdout + result.stderr
    suites = list(element_tree.parse(report_path).getroot().iter('testsuite'))
    assert sum(int(suite.attrib['tests']) for suite in suites) == 19
    assert sum(int(suite.attrib['errors']) for suite in suites) == 0
    expected_failures = 1 if name == 'failing_test' else 0
    assert sum(int(suite.attrib['failures']) for suite in suites) == expected_failures
    assert not (workspace / '.paradox-demo').exists()
    assert not (workspace / '.pytest_cache').exists()


def test_broken_recipe_is_rejected_by_compile_not_collection(workspace, tmp_path):
    apply_recipe(workspace, 'broken')
    result = subprocess.run(
        [sys.executable, '-m', 'compileall', '-q', 'demo_app'], cwd=workspace,
        env=validation_environment(tmp_path), capture_output=True, text=True, timeout=15,
    )
    assert result.returncode != 0
    assert 'SyntaxError' in result.stdout + result.stderr
    assert 'ranking.py' in result.stdout + result.stderr


def test_delete_recipe_removes_exactly_one_existing_base_test(workspace):
    before = {path.relative_to(workspace) for path in workspace.rglob('*') if path.is_file()}
    apply_recipe(workspace, 'delete_test')
    after = {path.relative_to(workspace) for path in workspace.rglob('*') if path.is_file()}
    assert before - after == {Path('demo_app/tests/test_feed_contract.py')}
    assert not after - before
