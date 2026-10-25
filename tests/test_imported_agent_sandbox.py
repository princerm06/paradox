import os
from pathlib import Path
import subprocess
import sys

import pytest

from engine import imported_agent_sandbox as sandbox
from engine.adapters.fastapi_sqlite import ADAPTER


@pytest.fixture
def future(tmp_path):
    code = tmp_path / "future" / "code"
    (code / "tests").mkdir(parents=True)
    (code / "pkg").mkdir()
    (code / "pkg" / "main.py").write_text("original")
    (code / "pkg" / "requirements-dev.txt").write_text("frozen")
    (code / "tests" / "test_original.py").write_text("frozen")
    (code / "tests" / "conftest.py").write_text("frozen")
    (code / "requirements.txt").write_text("fastapi\nuvicorn\npytest\nhttpx\n")
    profile = ADAPTER.profile(dict(adapter=ADAPTER.id, app="pkg.main:app", tests="tests",
                                   health_path="/health", state_env="PARADOX_APP_DIR"))
    yield code, profile
    sandbox.cleanup(code)


def test_protected_inventory(future):
    code, profile = future
    assert sandbox.protected_files(code, profile) == (
        "pkg/requirements-dev.txt", "requirements.txt", "tests/conftest.py", "tests/test_original.py")


@pytest.mark.parametrize("name", sorted(sandbox.FORBIDDEN))
def test_control_autoload_rejected(future, name):
    code, profile = future
    (code / "pkg" / name).write_text("configuration")
    with pytest.raises(ValueError, match="configuration/control"):
        sandbox.protected_files(code, profile)


@pytest.mark.parametrize("kind", ["symlink", "hardlink", "fifo"])
def test_unsafe_inventory_rejected(future, kind):
    code, profile = future
    target = code / "unsafe"
    if kind == "symlink":
        target.symlink_to(code / "pkg/main.py")
    elif kind == "hardlink":
        os.link(code / "pkg/main.py", target)
    else:
        os.mkfifo(target)
    with pytest.raises(ValueError, match="private regular"):
        sandbox.protected_files(code, profile)


def test_bounded_inventory(future, monkeypatch):
    code, profile = future
    monkeypatch.setattr(sandbox, "MAX_PATHS", 2)
    with pytest.raises(ValueError, match="path limits"):
        sandbox.protected_files(code, profile)


def test_non_macos_fail_closed(monkeypatch):
    monkeypatch.setattr(sandbox.sys, "platform", "linux")
    assert "no unsandboxed fallback" in sandbox.availability_reason()


macos = pytest.mark.skipif(sys.platform != "darwin", reason="macOS sandbox enforcement required")


@macos
def test_availability():
    assert sandbox.availability_reason() is None


def run(code, profile, script, *arguments):
    command, environment = sandbox.prepare(
        code, [sys.executable, "-I", "-B", "-c", script, *map(str, arguments)], {}, profile)
    return subprocess.run(command, cwd=code, env=environment, capture_output=True, text=True, timeout=10)


@macos
def test_agent_can_edit_create_but_not_frozen_files(future):
    code, profile = future
    script = """
from pathlib import Path
import os
Path('pkg/main.py').write_text('edited')
Path('tests/test_new.py').write_text('new test')
Path(os.environ['HOME'], '.factory', 'session').write_text('operational')
Path(os.environ['TMPDIR'], 'temp').write_text('temporary')
"""
    result = run(code, profile, script)
    assert result.returncode == 0, result.stderr
    assert (code / "pkg/main.py").read_text() == "edited"
    assert (code / "tests/test_new.py").is_file()


@macos
@pytest.mark.parametrize("attack", ["write", "unlink", "replace", "rename_parent", "hardlink", "symlink"])
def test_protected_replacement_and_alias_attacks_denied(future, attack):
    code, profile = future
    script = """
import os,sys
from pathlib import Path
target=Path('tests/test_original.py')
try:
 if sys.argv[1]=='write': target.write_text('attacker')
 elif sys.argv[1]=='unlink': target.unlink()
 elif sys.argv[1]=='replace':
  Path('replacement').write_text('attacker')
  os.replace('replacement',target)
 elif sys.argv[1]=='rename_parent': Path('tests').rename('moved')
 elif sys.argv[1]=='hardlink':
  os.link(target,'alias')
  Path('alias').write_text('attacker')
 elif sys.argv[1]=='symlink':
  Path('alias').symlink_to(target)
  Path('alias').write_text('attacker')
except PermissionError: raise SystemExit(0)
raise SystemExit(9)
"""
    result = run(code, profile, script, attack)
    assert result.returncode == 0, result.stderr
    assert (code / "tests/test_original.py").read_text() == "frozen"


@macos
@pytest.mark.parametrize("attack", ["direct", "hardlink", "symlink", "state", "control", "upper_control", "hook"])
def test_source_state_and_new_control_paths_not_writable(future, tmp_path, attack):
    code, profile = future
    outside = tmp_path / "source.sqlite3"
    outside.write_text("source sentinel")
    state = code.parent / "state"
    state.mkdir()
    script = """
import os,sys
from pathlib import Path
source,state=map(Path,sys.argv[2:])
try:
 if sys.argv[1]=='direct': source.write_text('attacker')
 elif sys.argv[1]=='state': (state/'database').write_text('attacker')
 elif sys.argv[1]=='control':
  Path('pkg/.factory').mkdir()
  Path('pkg/.factory/settings.json').write_text('attacker')
 elif sys.argv[1]=='upper_control': Path('pkg/.MCP.JSON').write_text('attacker')
 elif sys.argv[1]=='hook': Path('pkg/custom.pth').write_text('attacker')
 elif sys.argv[1]=='hardlink':
  os.link(source,'escape')
  Path('escape').write_text('attacker')
 elif sys.argv[1]=='symlink':
  Path('escape').symlink_to(source)
  Path('escape').write_text('attacker')
except PermissionError: raise SystemExit(0)
raise SystemExit(9)
"""
    result = run(code, profile, script, attack, outside, state)
    assert result.returncode == 0, result.stderr
    assert outside.read_text() == "source sentinel"
    assert not list(state.iterdir())


@macos
def test_only_trusted_agent_receives_factory_credential(future, monkeypatch):
    code, profile = future
    sentinels = {name: "dummy-" + name for name in (
        "FACTORY_API_KEY", "PARADOX_TOKEN", "PARADOX_SHELL_TOKEN", "ANTHROPIC_API_KEY")}
    for name, value in sentinels.items():
        monkeypatch.setenv(name, value)
    command, environment = sandbox.prepare(code, [sys.executable, "-I", "-c", "pass"],
                                           dict(sentinels, NODE_OPTIONS="untrusted"), profile)
    assert environment["FACTORY_API_KEY"] == sentinels["FACTORY_API_KEY"]
    assert environment["PARADOX_DROID_SANDBOX"] == sandbox.MARKER
    assert not set(sentinels).difference({"FACTORY_API_KEY"}).intersection(environment)
    assert "NODE_OPTIONS" not in environment
    assert environment["HOME"] != os.environ["HOME"]


@macos
def test_probe_failure_prevents_agent_launch(future, monkeypatch):
    code, profile = future
    monkeypatch.setattr(sandbox.subprocess, "run", lambda *args, **kwargs: subprocess.CompletedProcess([], 1))
    with pytest.raises(RuntimeError, match="enforcement failed"):
        sandbox.prepare(code, [sys.executable, "-I", "-c", "pass"], {}, profile)


@macos
def test_private_agent_state_is_outside_application_read_boundary(future):
    from engine.adapters import exec_sandbox

    code, profile = future
    command, environment = sandbox.prepare(code, [sys.executable, "-I", "-c", "pass"], {}, profile)
    secret = Path(environment["HOME"]) / ".factory" / "session"
    secret.write_text("dummy-session-secret")
    temporary = code.parent / "runtime-tmp"
    temporary.mkdir()
    script = """
import pathlib,sys
try: pathlib.Path(sys.argv[1]).read_text()
except PermissionError: raise SystemExit(0)
raise SystemExit(9)
"""
    application = exec_sandbox.wrap([sys.executable, "-I", "-c", script, str(secret)],
                                    [temporary], code.parent)
    result = subprocess.run(application, cwd=code, env=exec_sandbox.environment({}, temporary),
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert code.parent not in secret.parents
    sandbox.cleanup(code)
    assert not secret.exists()


@macos
def test_cleanup_is_idempotent_and_private(future, tmp_path):
    code, profile = future
    sandbox.prepare(code, [sys.executable, "-I", "-c", "pass"], {}, profile)
    operations = sandbox._operations(code.resolve())
    assert operations.stat().st_mode & 0o777 == 0o700
    sandbox.cleanup(code)
    sandbox.cleanup(code)
    outside = tmp_path / "untouched"
    outside.mkdir()
    operations.symlink_to(outside, target_is_directory=True)
    try:
        with pytest.raises(ValueError, match="private non-symlink"):
            sandbox.cleanup(code)
        assert outside.is_dir()
    finally:
        operations.unlink()
