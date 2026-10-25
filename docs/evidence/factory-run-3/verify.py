"""Offline consistency verification; never starts Factory or the engine."""

import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ElementTree


ROOT = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require(condition, description):
    if not condition:
        raise ValueError(description)


def verify(run_tests):
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    files = {str(path.relative_to(ROOT)) for path in ROOT.rglob('*') if path.is_file()}
    indexed = {item['path'] for item in manifest['files']}
    require(files == indexed | {'manifest.json', 'SHA256SUMS'}, 'Unexpected or missing package files')
    for item in manifest['files']:
        path = ROOT / item['path']
        require(path.stat().st_size == item['bytes'] and digest(path) == item['sha256'],
                'Manifest mismatch: ' + item['path'])
    checksums = {}
    for line in (ROOT / 'SHA256SUMS').read_text().splitlines():
        expected, name = line.split('  ', 1)
        require(name in files and name not in checksums, 'Invalid checksum entry')
        checksums[name] = expected
        require(digest(ROOT / name) == expected, 'Checksum mismatch: ' + name)
    require(set(checksums) == files - {'SHA256SUMS'}, 'Incomplete checksum coverage')
    evidence = json.loads((ROOT / 'artifacts/http-evidence.json').read_text())
    generation = evidence['generation']
    require(evidence['verified'] is True and generation['provider'] == 'droid'
            and generation['status'] == 'succeeded', 'Saved run did not succeed with Droid')
    require(evidence['generation_id'] == generation['id'] == manifest['generation_id'], 'Generation ID mismatch')
    require(generation['agent']['session_id'] == manifest['session_id'], 'Session ID mismatch')
    require(generation['timeline_id'] == manifest['timeline_id'], 'Timeline ID mismatch')
    require(evidence['sdk_version'] == '0.10.0', 'Unexpected recorded SDK version')
    checks = generation['evaluation']['checks']
    require(generation['evaluation']['passed'] is True and len(checks) == 6
            and {item['name'] for item in checks} == {'agent', 'guard', 'compile', 'tests', 'boot', 'smoke'}
            and all(item['status'] == 'passed' for item in checks), 'Saved validation mismatch')
    validation = (ROOT / 'artifacts/validation.log').read_text()
    for check in checks:
        require(check['name'] + ': passed' in validation, 'Missing validation log outcome')
    report = ElementTree.parse(ROOT / 'artifacts/tests.xml').getroot()
    suites = report.findall('testsuite')
    require(len(suites) == 1, 'Unexpected JUnit suite count')
    suite = suites[0]
    require(suite.attrib['tests'] == '26' and all(suite.attrib[key] == '0'
            for key in ('failures', 'errors', 'skipped')), 'Saved JUnit totals mismatch')
    cases = suite.findall('testcase')
    require(len(cases) == 26 and not suite.findall('.//failure') and not suite.findall('.//error')
            and not suite.findall('.//skipped'), 'Saved testcase outcomes mismatch')
    added_cases = [case for case in cases if case.attrib['classname'] == 'demo_app.tests.test_popular_ranking']
    require(len(added_cases) == 8 and '26 passed' in validation and 'Immutable baseline collected 18 tests' in validation,
            'Baseline/new test counts mismatch')
    require(generation['evaluation']['tests'] == {'passed': 26, 'failed': 0, 'errors': 0}, 'Evaluation test totals mismatch')
    records = [json.loads(line) for line in (ROOT / 'artifacts/sdk-session.jsonl').read_text().splitlines()]
    require(len(records) == 14 and records[0]['id'] == manifest['session_id'], 'Public transcript mismatch')
    tools = [block for record in records for block in record.get('message', {}).get('content', [])
             if block.get('type') == 'tool_use']
    require(collections.Counter(tool['name'] for tool in tools) == {'Read': 5, 'LS': 2, 'Edit': 1, 'Create': 1},
            'SDK tool counts mismatch')
    agent_log = (ROOT / 'artifacts/agent.log').read_text()
    require(manifest['session_id'] in agent_log and 'permission handler audit: invoked=2' in agent_log
            and agent_log.count('permission proceed_once: approved ') == 2, 'Permission audit mismatch')
    listing = evidence['timeline_listing']
    child = next(item for item in listing['timelines'] if item['id'] == manifest['timeline_id'])
    require(child['generation_id'] == manifest['generation_id'] and child['modification'] == 'ai'
            and child['parent_id'] == generation['parent_id'], 'Child timeline provenance mismatch')
    require(listing['active_timeline_id'] == generation['parent_id']
            and evidence['health']['active_timeline_id'] == child['id'], 'Activation capture mismatch')
    require(evidence['parent_feed']['ordering'] == 'chronological'
            and evidence['child_feed']['ordering'] == 'popular', 'Saved feed ordering mismatch')
    likes = [post['likes'] for post in evidence['child_feed']['posts']]
    require(likes == sorted(likes, reverse=True), 'Saved child feed not sorted by popularity')
    parent_contents = {post['content'] for post in evidence['parent_feed']['posts']}
    revisited = evidence['revisited_child_feed']['posts']
    require('parent only' in parent_contents and 'child only' not in parent_contents
            and all(post['content'] != 'parent only' for post in revisited)
            and next(post['likes'] for post in revisited if post['content'] == 'child only') == 1,
            'Saved isolation/restoration observations mismatch')
    patch = ROOT / 'artifacts/generated.patch'
    targets = [line[4:] for line in patch.read_text().splitlines() if line.startswith('+++ ')]
    require(targets == ['b/demo_app/ranking.py', 'b/demo_app/tests/test_popular_ranking.py'], 'Unexpected patch targets')
    with tempfile.TemporaryDirectory(prefix='factory-run-3-offline-') as temporary:
        workspace = Path(temporary)
        shutil.copytree(ROOT / 'baseline/demo_app', workspace / 'demo_app')
        ranking = workspace / 'demo_app/ranking.py'
        require(digest(ranking) == evidence['source_hashes']['parent'], 'Parent source hash mismatch')
        old_source = ranking.read_text()
        subprocess.run(['git', 'apply', '--check', str(patch)], cwd=workspace, check=True)
        subprocess.run(['git', 'apply', str(patch)], cwd=workspace, check=True)
        require(digest(ranking) == evidence['source_hashes']['child'], 'Child source hash mismatch')
        replayed = {str(path.relative_to(workspace)): digest(path)
                    for path in sorted(workspace.rglob('*')) if path.is_file()}
        require(replayed == manifest['replayed_source_sha256'], 'Replayed source differs from recovered workspace')
        edit = next(tool['input'] for tool in tools if tool['name'] == 'Edit')
        create = next(tool['input'] for tool in tools if tool['name'] == 'Create')
        require(old_source.count(edit['old_str']) == 1
                and old_source.replace(edit['old_str'], edit['new_str']) == ranking.read_text(), 'SDK Edit/patch mismatch')
        added_test = workspace / 'demo_app/tests/test_popular_ranking.py'
        require(create['content'] == added_test.read_text(), 'SDK Create/patch mismatch')
        if run_tests:
            environment = os.environ.copy()
            environment['PYTEST_DISABLE_PLUGIN_AUTOLOAD'] = '1'
            environment['PYTHONDONTWRITEBYTECODE'] = '1'
            environment['PARADOX_APP_DIR'] = str(workspace / 'disposable-app-state')
            environment.pop('PYTEST_ADDOPTS', None)
            environment.pop('PYTHONPATH', None)
            print('New offline replay (not the historical SDK run):', flush=True)
            subprocess.run([sys.executable, '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-c', '/dev/null',
                            '--rootdir', str(workspace), 'demo_app/tests'], cwd=workspace,
                           env=environment, check=True)
    print('PASS: public checksums, 26 saved tests, six saved checks, SDK writes, timeline observations and patch replay.')
    print('No Factory calls made; original runtime/sandbox/adoption checks were not rerun.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--test', action='store_true', help='Also rerun recovered demo tests in a temporary directory')
    try:
        verify(parser.parse_args().test)
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print('FAIL: ' + str(error), file=sys.stderr)
        sys.exit(1)
