from pathlib import Path
import os
import json
import runpy
import shutil
import signal
import subprocess
import sys
import time

import httpx
import pytest

from engine.adapters.fastapi_sqlite import ADAPTER
from engine.adapters import exec_sandbox
from engine.service import Engine
from engine.jobs import scrubbed_environment


@pytest.fixture
def imported(tmp_path):
    builder = runpy.run_path(str(Path(__file__).parent / "fixtures/projects/build.py"))
    repository = builder["build_notes_repo"](tmp_path)
    code = tmp_path / "import/code"
    shutil.copytree(repository, code, ignore=shutil.ignore_patterns(".git"))
    profile = ADAPTER.profile(dict(adapter=ADAPTER.id, app="notes_app.main:app", tests="tests",
                                  health_path="/health", state_env="PARADOX_APP_DIR"))
    return repository, code, profile


def test_real_sandboxed_runtime_and_restart(imported, tmp_path):
    repository, code, profile = imported
    before = {path.relative_to(repository): (path.read_bytes(), path.stat().st_mtime_ns)
              for path in repository.rglob("*") if path.is_file()}
    for name in ("FACTORY_API_KEY", "PARADOX_TOKEN", "PARADOX_SHELL_TOKEN", "ANTHROPIC_API_KEY"):
        assert name not in exec_sandbox.environment({}, tmp_path)
    engine = Engine(tmp_path / "engine", code, 0, profile=profile)
    engine.start()
    try:
        with httpx.Client(base_url=engine.runtime.url, trust_env=False) as client:
            assert client.get("/health").status_code == 200
            assert client.post("/api/notes", json={"content": "Persisted", "priority": 4}).status_code == 201
        active = engine.active_id
    finally:
        engine.close()
    engine = Engine(tmp_path / "engine", code, 0, profile=profile)
    engine.start()
    try:
        assert engine.active_id == active
        assert "Persisted" in httpx.get(engine.runtime.url + "/api/notes", trust_env=False).text
    finally:
        engine.close()
    assert before == {path.relative_to(repository): (path.read_bytes(), path.stat().st_mtime_ns)
                      for path in repository.rglob("*") if path.is_file()}


def test_runtime_fails_closed_without_sandbox(imported, tmp_path, monkeypatch):
    repository, code, profile = imported
    monkeypatch.setattr(exec_sandbox, "availability_reason", lambda: "probe denied")
    engine = Engine(tmp_path / "engine", code, 0, profile=profile)
    with pytest.raises(RuntimeError, match="execution_sandbox_unavailable"):
        engine.start()
    assert engine.runtime.process is None


def test_http_runtime_security_boundary(imported, tmp_path, monkeypatch):
    repository, code, profile = imported
    names = ("FACTORY_API_KEY", "PARADOX_TOKEN", "PARADOX_SHELL_TOKEN", "ANTHROPIC_API_KEY")
    for name in names:
        monkeypatch.setenv(name, "nonsecret-runtime-sentinel")
    probe = '''
import ctypes, socket, subprocess
@app.get("/probe")
def probe():
    result = {name: name not in os.environ for name in %r}
    operations = {
        "source_write": lambda: Path(__file__).write_text("bad"),
        "outside_read": lambda: Path(%r).read_text(),
        "outside_write": lambda: Path(%r).write_text("bad"),
        "home_read": lambda: Path(%r).read_text(),
        "outbound": lambda: socket.create_connection(("1.1.1.1", 80), timeout=1),
        "shell": lambda: subprocess.run(["/bin/sh", "-c", "true"], check=True),
        "engine_signal": lambda: os.kill(%d, 0),
        "dns": lambda: socket.getaddrinfo("example.com", 80),
    }
    for name, operation in operations.items():
        try:
            operation()
        except (OSError, subprocess.SubprocessError):
            result[name] = True
        else:
            result[name] = False
    library = ctypes.CDLL(None, use_errno=True)
    bootstrap = ctypes.c_uint.in_dll(library, "bootstrap_port")
    service = ctypes.c_uint()
    result["clipboard"] = library.bootstrap_look_up(bootstrap, b"com.apple.pasteboard.1", ctypes.byref(service)) == 1100
    mib = (ctypes.c_int * 3)(1, 49, %d)
    size = ctypes.c_size_t(262144)
    buffer = ctypes.create_string_buffer(size.value)
    result["engine_environment"] = library.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) == -1
    return result
'''
    secret = tmp_path / "outside-secret"
    secret.write_text("nonsecret")
    main = code / "notes_app/main.py"
    main.write_text(main.read_text() + probe % (names, str(secret), str(tmp_path / "outside-write"),
                                              str(Path.home() / ".zshrc"), os.getpid(), os.getpid()))
    engine = Engine(tmp_path / "engine", code, 0, profile=profile)
    engine.start()
    try:
        result = httpx.get(engine.runtime.url + "/probe", trust_env=False).json()
        assert result and all(result.values()), result
        assert not list(engine.storage.snapshots.rglob(".runtime-*"))
    finally:
        engine.close()
    assert not list((engine.root / "workspace").glob(".runtime-*"))


def test_engine_crash_stops_sandbox_tree_and_reopens_state(imported, tmp_path):
    repository, code, profile = imported
    main = code / "notes_app/main.py"
    main.write_text(main.read_text() + '''
import subprocess, sys
state.mkdir(parents=True, exist_ok=True)
worker = subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(60)"])
(state / "worker.pid").write_text(str(worker.pid))
''')
    root = tmp_path / "engine"
    script = '''
import json, time
from pathlib import Path
from engine.adapters.fastapi_sqlite import ADAPTER
from engine.service import Engine
profile = ADAPTER.profile(%r)
engine = Engine(Path(%r), Path(%r), 0, profile=profile)
engine.start()
print(json.dumps(dict(pid=engine.runtime.process.pid, url=engine.runtime.url)), flush=True)
time.sleep(60)
''' % (dict(adapter=profile.adapter, app=profile.app, tests=profile.tests,
            health_path=profile.health_path, state_env=profile.state_env), str(root), str(code))
    parent = subprocess.Popen([sys.executable, "-u", "-c", script], cwd=Path(__file__).resolve().parents[1],
                              env=scrubbed_environment(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    runtime_pid = None
    try:
        import selectors
        with selectors.DefaultSelector() as selector:
            selector.register(parent.stdout, selectors.EVENT_READ)
            assert selector.select(20), "Engine did not start"
        started = json.loads(parent.stdout.readline())
        runtime_pid = started["pid"]
        url = started["url"]
        assert httpx.post(url + "/api/notes", json={"content": "before crash"}, trust_env=False).status_code == 201
        worker_pid = int((root / "workspace/state/worker.pid").read_text())
        parent.kill()
        parent.wait(timeout=5)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            records = subprocess.run(["/bin/ps", "-o", "stat=", "-p", str(runtime_pid) + "," + str(worker_pid)],
                                     env=scrubbed_environment(), capture_output=True, text=True).stdout.split()
            if not records or all(record.startswith("Z") for record in records):
                break
            time.sleep(.05)
        else:
            pytest.fail("Sandbox descendants survived engine death")
        engine = Engine(root, code, 0, profile=profile)
        engine.start()
        try:
            assert "before crash" in httpx.get(engine.runtime.url + "/api/notes", trust_env=False).text
            assert len(list((root / "workspace").glob(".runtime-*"))) == 1
        finally:
            engine.close()
    finally:
        if parent.poll() is None:
            parent.kill()
        parent.wait(timeout=5)
        parent.stdout.close()
        parent.stderr.close()
        if runtime_pid:
            try:
                os.killpg(runtime_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


@pytest.mark.xfail(strict=True, reason="P1: detached sandbox descendants escape process-group cleanup; M2 NO-GO")
def test_detached_sandbox_child_must_not_survive_runtime_close(imported, tmp_path):
    repository, code, profile = imported
    main = code / "notes_app/main.py"
    main.write_text(main.read_text() + '''
import subprocess, sys
state.mkdir(parents=True, exist_ok=True)
worker = subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(60)"], start_new_session=True)
(state / "detached.pid").write_text(str(worker.pid))
''')
    engine = Engine(tmp_path / "engine", code, 0, profile=profile)
    detached = None
    log_thread = None
    try:
        engine.start()
        detached = int((engine.root / "workspace/state/detached.pid").read_text())
        log_thread = engine.runtime.log_thread
        engine.close()
        record = subprocess.run(["/bin/ps", "-o", "stat=", "-p", str(detached)],
                                env=scrubbed_environment(), capture_output=True, text=True).stdout.strip()
        assert not record or record.startswith("Z"), "Detached sandbox process survived close"
    finally:
        if engine.storage is not None:
            engine.close(checkpoint=False)
        if detached:
            try:
                os.killpg(detached, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if log_thread:
            log_thread.join(timeout=5)
