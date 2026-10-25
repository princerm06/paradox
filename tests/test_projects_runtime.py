from pathlib import Path
import os
import runpy
import shutil

import httpx
import pytest

from engine.adapters.fastapi_sqlite import ADAPTER
from engine.adapters import exec_sandbox
from engine.service import Engine


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
