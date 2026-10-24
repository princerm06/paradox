import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

from engine import droid_sandbox
from engine.jobs import scrubbed_environment


ADAPTER = Path(__file__).parents[1] / 'engine/droid_adapter/dist/adapter.js'
requires_macos = pytest.mark.skipif(sys.platform != 'darwin', reason='macOS kernel write sandbox required')


@pytest.fixture
def future(tmp_path):
    code = tmp_path / 'future' / 'workspace' / 'code'
    (code / 'demo_app').mkdir(parents=True)
    (code.parent / 'state').mkdir()
    (code / 'README.md').write_text('code outside demo_app')
    (code.parent / 'state' / 'app.sqlite3').write_text('frozen database sentinel')
    return code


def test_non_macos_fails_closed(monkeypatch):
    monkeypatch.setattr(droid_sandbox.sys, 'platform', 'linux')
    assert 'no unsandboxed fallback' in droid_sandbox.availability_reason()


def test_missing_profile_fails_closed(tmp_path, monkeypatch):
    monkeypatch.setattr(droid_sandbox.sys, 'platform', 'darwin')
    monkeypatch.setattr(droid_sandbox, 'EXECUTABLE', Path(sys.executable))
    monkeypatch.setattr(droid_sandbox, 'PROFILE', tmp_path / 'missing.sb')
    assert 'profile is missing' in droid_sandbox.availability_reason()


def test_missing_sandbox_binary_fails_closed(tmp_path, monkeypatch):
    monkeypatch.setattr(droid_sandbox.sys, 'platform', 'darwin')
    monkeypatch.setattr(droid_sandbox, 'EXECUTABLE', tmp_path / 'missing')
    assert 'sandbox-exec is unavailable' in droid_sandbox.availability_reason()


@requires_macos
def test_offline_availability_enforces_writes():
    assert droid_sandbox.availability_reason() is None


@pytest.mark.parametrize('failure', ['exit', 'timeout', 'os-error'])
def test_failed_availability_is_unavailable(monkeypatch, failure):
    monkeypatch.setattr(droid_sandbox, 'platform_reason', lambda: None)
    def run(command, **kwargs):
        assert 'FACTORY_API_KEY' not in kwargs['env']
        if failure == 'timeout':
            raise subprocess.TimeoutExpired(command, 5)
        if failure == 'os-error':
            raise OSError('sandbox failed')
        return subprocess.CompletedProcess(command, 71)
    monkeypatch.setattr(droid_sandbox.subprocess, 'run', run)
    assert 'sandbox' in droid_sandbox.availability_reason()


@requires_macos
def test_production_sandbox_enforces_demo_scope_and_symlinks(future, tmp_path):
    node = shutil.which('node')
    if not node or not ADAPTER.is_file():
        pytest.skip('built Node adapter required')
    outside = tmp_path / 'outside.txt'
    outside.write_text('outside sentinel')
    script = '''
const {writeFileSync,readFileSync,symlinkSync,linkSync}=await import('node:fs');
const {spawnSync}=await import('node:child_process');
const assert=(await import('node:assert/strict')).default;
const {verifyWriteSandbox}=await import(ADAPTER_URL);
verifyWriteSandbox(CODE);
const denied=(target)=>assert.throws(()=>writeFileSync(target,'denied'),error=>['EPERM','EACCES'].includes(error.code));
writeFileSync(CODE+'/demo_app/allowed.py','allowed');
for(const target of [CODE+'/README.md',CODE+'/engine.py',CODE+'/../state/app.sqlite3',OUTSIDE])denied(target);
symlinkSync(OUTSIDE,CODE+'/demo_app/outside-link');
denied(CODE+'/demo_app/outside-link');
symlinkSync(CODE+'/README.md',CODE+'/demo_app/workspace-link');
denied(CODE+'/demo_app/workspace-link');
try{linkSync(OUTSIDE,CODE+'/demo_app/hard-link');denied(CODE+'/demo_app/hard-link');}
catch(error){if(!['EPERM','EACCES'].includes(error.code))throw error;}
const child=spawnSync(process.execPath,['-e',"require('fs').writeFileSync(process.argv[1],'denied')",OUTSIDE],{encoding:'utf8'});
assert.notEqual(child.status,0);
assert.match(child.stderr,/EPERM|EACCES/);
writeFileSync(process.env.HOME+'/.factory/operational.txt','private');
writeFileSync(process.env.TMPDIR+'/scratch.txt','private');
assert.equal(readFileSync(OUTSIDE,'utf8'),'outside sentinel');
console.log(JSON.stringify({scope:'enforced',symlink:'denied',child:'denied'}));
'''.replace('ADAPTER_URL', json.dumps(ADAPTER.as_uri())).replace('CODE', json.dumps(str(future))).replace('OUTSIDE', json.dumps(str(outside)))
    command, environment = droid_sandbox.prepare(future, [node, '--input-type=module', '-e', script, str(future)], scrubbed_environment())
    result = subprocess.run(command, capture_output=True, text=True, env=environment, timeout=15)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)['scope'] == 'enforced'
    assert environment['HOME'] != os.environ.get('HOME')
    assert environment['PARADOX_DROID_SANDBOX'] == droid_sandbox.MARKER
    assert (Path(environment['HOME']).stat().st_mode & 0o777) == 0o700
    assert outside.read_text() == 'outside sentinel'
    assert (future / 'README.md').read_text() == 'code outside demo_app'
    assert (future.parent / 'state/app.sqlite3').read_text() == 'frozen database sentinel'
    assert not list(future.glob('.sandbox-*'))
    assert not list((future / 'demo_app').glob('.sandbox-*'))


@requires_macos
def test_sandbox_allows_required_network_without_model_turn(future):
    script = 'import socket\nserver=socket.socket();server.bind(("127.0.0.1",0));server.listen();client=socket.create_connection(server.getsockname());accepted,_=server.accept();client.sendall(b"ok");assert accepted.recv(2)==b"ok"'
    command, environment = droid_sandbox.prepare(future, [sys.executable, '-I', '-B', '-c', script], scrubbed_environment())
    assert subprocess.run(command, env=environment, capture_output=True, timeout=10).returncode == 0


@pytest.mark.parametrize('failure', ['exit', 'timeout', 'os-error'])
def test_initialization_failure_never_launches_sdk(future, monkeypatch, failure):
    monkeypatch.setattr(droid_sandbox, 'platform_reason', lambda: None)
    def run(command, **kwargs):
        assert 'FACTORY_API_KEY' not in kwargs['env']
        if failure == 'timeout':
            raise subprocess.TimeoutExpired(command, 5)
        if failure == 'os-error':
            raise OSError('sandbox unavailable')
        return subprocess.CompletedProcess(command, 71)
    monkeypatch.setattr(droid_sandbox.subprocess, 'run', run)
    with pytest.raises(RuntimeError, match='refusing to start the SDK'):
        droid_sandbox.prepare(future, ['must-not-run-sdk'], {'FACTORY_API_KEY': 'test-not-a-real-key'})


@requires_macos
def test_noop_profile_is_detected_and_does_not_fall_back(future, tmp_path, monkeypatch):
    profile = tmp_path / 'unsafe.sb'
    profile.write_text('(version 1)(allow default)')
    monkeypatch.setattr(droid_sandbox, 'PROFILE', profile)
    with pytest.raises(RuntimeError, match='enforcement failed'):
        droid_sandbox.prepare(future, ['must-not-run-sdk'], scrubbed_environment())
    assert not list(future.glob('.sandbox-*'))


@requires_macos
def test_symlinked_operational_home_is_rejected(future, tmp_path):
    (future.parent / '.code-droid').symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(RuntimeError, match='may not be symlinks'):
        droid_sandbox.prepare(future, ['must-not-run-sdk'], scrubbed_environment())


@requires_macos
def test_symlinked_app_is_rejected(future, tmp_path):
    (future / 'demo_app').rmdir()
    (future / 'demo_app').symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(RuntimeError, match='real demo_app'):
        droid_sandbox.prepare(future, ['must-not-run-sdk'], scrubbed_environment())


@requires_macos
def test_real_cli_starts_with_private_home_and_no_network(future, tmp_path, monkeypatch):
    droid = shutil.which('droid')
    if not droid:
        pytest.skip('Droid CLI required for metadata-only startup')
    profile = tmp_path / 'offline.sb'
    profile.write_text(droid_sandbox.PROFILE.read_text() + '\n(deny network*)\n')
    monkeypatch.setattr(droid_sandbox, 'PROFILE', profile)
    command, environment = droid_sandbox.prepare(future, [droid, 'exec', '--list-tools', '--model', 'claude-sonnet-4-6', '--output-format', 'json', '--remove-tools', 'Execute,Script,WaitForScript'], scrubbed_environment())
    assert 'FACTORY_API_KEY' not in environment
    result = subprocess.run(command, capture_output=True, text=True, env=environment, timeout=20)
    assert result.returncode == 0, result.stderr
    catalog = {item['llmId']: item for item in json.loads(result.stdout)}
    assert not catalog['Execute']['currentlyAllowed']
    assert catalog['Read']['currentlyAllowed']


@requires_macos
def test_real_sdk_explicit_enablement_under_production_sandbox_without_turn(future, tmp_path, monkeypatch):
    node = shutil.which('node')
    if not node or not shutil.which('droid') or not ADAPTER.is_file():
        pytest.skip('Built official SDK adapter and CLI required for metadata-only probe')
    profile = tmp_path / 'offline-sdk.sb'
    profile.write_text(droid_sandbox.PROFILE.read_text() + '\n(deny network*)\n')
    monkeypatch.setattr(droid_sandbox, 'PROFILE', profile)
    probe = ADAPTER.parent.parent / 'research/sdk_metadata.mjs'
    command, environment = droid_sandbox.prepare(future, [node, str(probe), 'off', str(future), 'enabled'], scrubbed_environment())
    assert 'FACTORY_API_KEY' not in environment
    result = subprocess.run(command, capture_output=True, text=True, env=environment, timeout=25)
    assert result.returncode == 0, result.stderr
    events = [json.loads(line) for line in result.stdout.splitlines()]
    configured = [event for event in events if event.get('phase') == 'after-update']
    settings = next(event['settings'] for event in configured if 'settings' in event)
    assert settings['autonomyLevel'] == 'off'
    assert settings['toolExecutionMode'] == 'direct_only'
    assert settings['modelId'] == 'claude-sonnet-4-6'
    catalog = {tool['id']: tool for event in configured if 'tools' in event for tool in event['tools']}
    for name in ('Read', 'Edit', 'Create'):
        assert catalog[name]['allowed'] is True
    for name in ('Execute', 'Script', 'WaitForScript'):
        assert name not in catalog or catalog[name]['allowed'] is False
    assert catalog['Execute']['allowed'] is False
    assert events[-1] == {'permissionRequests': 0, 'modelTurns': 0}


def test_adapter_entrypoint_rejects_unsandboxed_launch_before_sdk(future):
    node = shutil.which('node')
    if not node or not ADAPTER.is_file():
        pytest.skip('Built Node adapter required')
    environment = scrubbed_environment()
    environment['PARADOX_DROID_SANDBOX'] = droid_sandbox.MARKER
    result = subprocess.run([node, str(ADAPTER)], input=json.dumps({'cwd': str(future), 'prompt': 'must not stream'}),
                            capture_output=True, text=True, env=environment, timeout=5)
    assert result.returncode == 3
    events = [json.loads(line) for line in result.stdout.splitlines()]
    assert 'sandbox' in events[-1]['summary'].lower()
    assert events[-1]['session_id'] is None
    assert not list(future.glob('.sandbox-*'))
