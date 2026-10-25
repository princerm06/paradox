import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time

import httpx
import pytest

from engine.adapters import exec_sandbox
from engine.jobs import Cancelled, JobControl


SECRETS = ("FACTORY_API_KEY", "PARADOX_TOKEN", "PARADOX_SHELL_TOKEN", "ANTHROPIC_API_KEY")
ASSERT_ENV = "import os; assert not any(name in os.environ for name in %r); " % (SECRETS,)


@pytest.fixture(autouse=True)
def sentinels(monkeypatch):
    for name in SECRETS:
        monkeypatch.setenv(name, "nonsecret-sentinel-" + name)


@pytest.fixture
def run(tmp_path):
    if sys.platform != "darwin":
        pytest.skip("macOS sandbox-exec required")
    assert exec_sandbox.availability_reason() is None
    root = (tmp_path / "run").resolve()
    for name in ("code", "state", "tmp"):
        (root / name).mkdir(parents=True)
    return root


def execute(root, source, writable=None):
    return subprocess.run(
        exec_sandbox.wrap([sys.executable, "-c", ASSERT_ENV + source],
                          writable if writable is not None else [root / "state", root / "tmp"], root),
        cwd=root / "code", env=exec_sandbox.environment(
            dict(os.environ, PARADOX_APP_DIR=str(root / "state")), root / "tmp"),
        stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=15,
    )


def test_environment_ignores_credentials_and_injection(tmp_path):
    result = exec_sandbox.environment(dict(os.environ, PYTHONPATH="/untrusted", PYTHONHOME="/evil",
                                          DYLD_INSERT_LIBRARIES="/evil", PARADOX_APP_DIR="/state"), tmp_path)
    assert not any(name in result for name in SECRETS)
    assert "PYTHONHOME" not in result
    assert "DYLD_INSERT_LIBRARIES" not in result
    assert "/untrusted" not in result["PYTHONPATH"]
    assert result["HOME"] == result["TMPDIR"] == str(tmp_path.resolve())
    assert result["PARADOX_APP_DIR"] == "/state"
    assert result["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] == "1"


def test_unavailable_platform_fails_closed(monkeypatch, tmp_path):
    exec_sandbox.availability_reason.cache_clear()
    monkeypatch.setattr(exec_sandbox.sys, "platform", "unsupported")
    try:
        with pytest.raises(RuntimeError, match="unavailable"):
            exec_sandbox.wrap([sys.executable, "-c", "pass"], [], tmp_path)
    finally:
        exec_sandbox.availability_reason.cache_clear()


def test_state_writes_and_loopback_work(run):
    result = execute(run,
        "import sqlite3,socket,pathlib; "
        "connection=sqlite3.connect(os.path.join(os.environ['PARADOX_APP_DIR'],'nested.db')); "
        "connection.execute('create table proof(value)'); connection.commit(); connection.close(); "
        "listener=socket.socket(); listener.bind(('127.0.0.1',0)); listener.listen(); "
        "client=socket.create_connection(listener.getsockname(),timeout=2); "
        "peer,address=listener.accept(); client.sendall(b'ok'); assert peer.recv(2)==b'ok'; "
        "peer.close();client.close();listener.close()")
    assert result.returncode == 0, result.stderr
    assert (run / "state/nested.db").exists()


@pytest.mark.parametrize("service", [
    "com.apple.pasteboard.1", "com.apple.SecurityServer", "com.apple.securityd.xpc",
    "com.apple.coreservices.launchservicesd", "com.apple.cfprefsd.agent",
    "com.apple.cfprefsd.daemon", "com.apple.windowserver.active", "com.apple.dnssd.service",
])
def test_mach_service_lookup_denied(run, service):
    result = execute(run,
        "import ctypes; library=ctypes.CDLL(None); "
        "bootstrap=ctypes.c_uint.in_dll(library,'bootstrap_port'); port=ctypes.c_uint(); "
        "result=library.bootstrap_look_up(bootstrap,%r,ctypes.byref(port)); "
        "assert result==1100, 'Mach service lookup was not denied'" % service.encode())
    assert result.returncode == 0, result.stderr


def test_dns_resolution_unavailable(run):
    result = execute(run, "import socket; exec(%r)" % (
        "for host in ['localhost','example.com']:\n"
        " try:\n  socket.getaddrinfo(host,80)\n"
        " except (socket.gaierror,PermissionError):\n  pass\n"
        " else:\n  raise AssertionError('name resolution available')\n"))
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("operation", [
    "open(%r,'w').write('bad')",
    "open(%r).read()",
    "__import__('subprocess').run(['/bin/sh','-c','true'])",
    "__import__('socket').create_connection(('1.1.1.1',80),timeout=1)",
])
def test_hostile_operations_blocked(run, operation):
    secret = run.parent / "engine-secret"
    secret.write_text("nonsecret test fixture")
    expression = operation % str(secret) if "%r" in operation else operation
    result = execute(run, "exec(%r)" % (
        "try:\n " + expression + "\nexcept PermissionError:\n pass\nelse:\n raise AssertionError('not denied')"))
    assert result.returncode == 0, result.stderr
    assert secret.read_text() == "nonsecret test fixture"


def test_home_reads_denied(run):
    with tempfile.TemporaryDirectory(prefix=".paradox-sandbox-test-", dir=Path.home()) as directory:
        secret = Path(directory) / "private"
        secret.write_text("nonsecret fixture")
        result = execute(run, "exec(%r)" % (
            "try:\n open(%r).read()\nexcept PermissionError:\n pass\nelse:\n raise AssertionError('home readable')" % str(secret)))
        assert result.returncode == 0, result.stderr


def test_process_environment_inspection_denied(run):
    result = execute(run,
        "import ctypes; library=ctypes.CDLL(None,use_errno=True); "
        "mib=(ctypes.c_int*3)(1,49,%d); size=ctypes.c_size_t(262144); "
        "buffer=ctypes.create_string_buffer(size.value); "
        "result=library.sysctl(mib,3,buffer,ctypes.byref(size),None,0); "
        "assert result == -1 and ctypes.get_errno() in (1,13)" % os.getpid())
    assert result.returncode == 0, result.stderr


def test_process_tree_cannot_inspect_launcher_or_engine_environment(run):
    source = ASSERT_ENV + "import ctypes,pathlib,subprocess; " + "exec(%r)" % (
        "library=ctypes.CDLL(None,use_errno=True)\n"
        "for pid in [os.getppid(), %d]:\n"
        " mib=(ctypes.c_int*3)(1,49,pid)\n"
        " size=ctypes.c_size_t(262144)\n"
        " buffer=ctypes.create_string_buffer(size.value)\n"
        " assert library.sysctl(mib,3,buffer,ctypes.byref(size),None,0)==-1\n"
        " assert ctypes.get_errno() in (1,13)\n"
        " mib=(ctypes.c_int*4)(1,14,1,pid)\n"
        " size=ctypes.c_size_t(262144)\n"
        " assert library.sysctl(mib,4,buffer,ctypes.byref(size),None,0)==-1\n"
        " assert ctypes.get_errno() in (1,13)\n"
        " for name in ['kern.procargs2','kern.procargs']:\n"
        "  for qualified in [name, name+'.'+str(pid)]:\n"
        "   size=ctypes.c_size_t(262144)\n"
        "   assert library.sysctlbyname(qualified.encode(),buffer,ctypes.byref(size),None,0)==-1\n"
        " try:\n  subprocess.run(['/bin/ps','eww',str(pid)],capture_output=True,check=True)\n"
        " except PermissionError:\n  pass\n"
        " else:\n  raise AssertionError('ps executed')\n"
        " try:\n  pathlib.Path('/proc/%%d/environ' %% pid).read_bytes()\n"
        " except (PermissionError,FileNotFoundError):\n  pass\n"
        " else:\n  raise AssertionError('proc environment readable')\n" % os.getpid()
    )
    command = exec_sandbox.wrap([sys.executable, "-c", source], [run / "state", run / "tmp"], run)
    log = run / "tmp/tree.log"
    assert JobControl().run(command, run / "code", log, 15,
                            exec_sandbox.environment({}, run / "tmp")) == 0, log.read_text()


def test_stdlib_platform_queries_fail_safely(run):
    result = execute(run,
        "import platform; count=os.cpu_count(); "
        "assert count is None or isinstance(count,int) and count>0; "
        "assert platform.system()=='Darwin'; assert platform.machine(); print(count)")
    assert result.returncode == 0, result.stderr


def test_isolated_bootstrap_retains_engine_venv(run):
    source = (ASSERT_ENV + "import sys; sys.pycache_prefix=%r; import pytest,uvicorn; "
              "assert sys.prefix==%r; print('isolated bootstrap ok')") % (str(run / "tmp/pycache"), sys.prefix)
    result = subprocess.run(
        exec_sandbox.wrap([sys.executable, "-I", "-c", source], [run / "tmp"], run),
        cwd=run / "code", env=exec_sandbox.environment({}, run / "tmp"),
        capture_output=True, text=True, timeout=15,
    )
    assert result.returncode == 0, result.stderr
    assert "isolated bootstrap ok" in result.stdout


def test_signals_restricted_to_same_sandbox(run):
    source = ASSERT_ENV + "import subprocess,sys; exec(%r)" % (
        "for pid in [os.getppid(), %d]:\n"
        " try:\n  os.kill(pid,0)\n"
        " except PermissionError:\n  pass\n"
        " else:\n  raise AssertionError('could signal control plane')\n"
        "os.kill(os.getpid(),0)\n" % os.getpid())
    log = run / "tmp/signals.log"
    assert JobControl().run(
        exec_sandbox.wrap([sys.executable, "-c", source], [run / "tmp"], run),
        run / "code", log, 15, exec_sandbox.environment({}, run / "tmp"),
    ) == 0, log.read_text()


@pytest.mark.parametrize("mode", ["cancel", "timeout"])
def test_external_control_stops_sandboxed_process_group(run, mode):
    control = JobControl()
    ready = run / "state/child.pid"
    marker = run / "state/tick"
    child_source = (
        "import pathlib,os,time,signal; signal.signal(signal.SIGTERM,signal.SIG_IGN); exec(%r); "
        "pathlib.Path(%r).write_text(str(os.getpid())); exec(%r)"
    ) % (
        "for detach in [os.setsid, lambda: os.setpgid(0,0)]:\n"
        " try:\n  detach()\n except OSError as error:\n  assert error.errno in (1,13)\n"
        " else:\n  raise AssertionError('supervised session escaped')",
        str(ready),
        "while True:\n pathlib.Path(%r).write_text(str(time.monotonic_ns()))\n time.sleep(.05)" % str(marker),
    )
    source = ASSERT_ENV + "import sys; os.execv(sys.executable,[sys.executable,'-I','-c',%r])" % child_source
    command = exec_sandbox.wrap([sys.executable, "-c", source], [run / "state", run / "tmp"], run)
    errors = []

    def worker():
        try:
            control.run(command, run / "code", run / "tmp/control.log", 1 if mode == "timeout" else 15,
                        exec_sandbox.environment({}, run / "tmp"))
        except (Cancelled, TimeoutError) as error:
            errors.append(error)

    thread = threading.Thread(target=worker)
    thread.start()
    try:
        deadline = time.monotonic() + 5
        while not ready.exists() and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert ready.exists(), (run / "tmp/control.log").read_text()
        if mode == "cancel":
            control.cancel()
        thread.join(timeout=10)
        assert not thread.is_alive()
        assert len(errors) == 1
        assert isinstance(errors[0], Cancelled if mode == "cancel" else TimeoutError)
        pid = int(ready.read_text())
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            result = subprocess.run(["/bin/ps", "-o", "stat=", "-p", str(pid)],
                                    capture_output=True, text=True, env={"PATH": "/usr/bin:/bin"}, timeout=3)
            if not result.stdout.strip() or result.stdout.strip().startswith("Z"):
                break
            time.sleep(0.05)
        else:
            pytest.fail("Sandboxed worker survived process-group cleanup")
        previous = marker.read_bytes()
        time.sleep(.15)
        assert marker.read_bytes() == previous
    finally:
        control.cancel()
        thread.join(timeout=5)


def test_job_engine_death_stops_reexec_writer(run):
    import json
    import selectors
    import signal
    from engine.jobs import scrubbed_environment
    ready = run / "state/job.pid"
    marker = run / "state/job-tick"
    source = (
        "import os,pathlib,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
        "pathlib.Path(%r).write_text(str(os.getpid())); exec(%r)"
    ) % (str(ready), "while True:\n pathlib.Path(%r).write_text(str(time.monotonic_ns()))\n time.sleep(.05)" % str(marker))
    source = "import os,sys; os.execv(sys.executable,[sys.executable,'-I','-c',%r])" % source
    script = '''
import json, pathlib, threading, time
from engine.adapters import exec_sandbox
from engine.jobs import JobControl
import sys
root = pathlib.Path(%r)
control = JobControl()
command = exec_sandbox.wrap([sys.executable, '-I', '-c', %r], [root/'state',root/'tmp'], root)
threading.Thread(target=lambda: control.run(command,root/'code',root/'tmp/job.log',60,
                 exec_sandbox.environment({},root/'tmp'))).start()
while not (root/'state/job.pid').exists():
    time.sleep(.02)
with control.lock:
    monitor = next(iter(control.processes)).pid
print(json.dumps(dict(monitor=monitor, app=int((root/'state/job.pid').read_text()))), flush=True)
time.sleep(60)
''' % (str(run), source)
    parent = subprocess.Popen([sys.executable, '-u', '-c', script], cwd=Path(__file__).resolve().parents[1],
                              env=scrubbed_environment(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    started = {}
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(parent.stdout, selectors.EVENT_READ)
            assert selector.select(15), "Trusted job launcher failed to initialize"
        started = json.loads(parent.stdout.readline())
        parent.kill()
        parent.wait(timeout=5)
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            records = subprocess.run(['/bin/ps','-o','stat=','-p',str(started['monitor'])+','+str(started['app'])],
                                     env=scrubbed_environment(), capture_output=True, text=True).stdout.split()
            if not records or all(record.startswith('Z') for record in records):
                break
            time.sleep(.05)
        else:
            pytest.fail('Validation writer or supervisor survived engine death')
        previous = marker.read_bytes()
        time.sleep(.15)
        assert marker.read_bytes() == previous
    finally:
        if parent.poll() is None:
            parent.kill()
        parent.wait(timeout=5)
        parent.stdout.close()
        parent.stderr.close()
        for pid in started.values():
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def test_unapproved_binaries_cannot_execute(run):
    import shutil
    copied = run / "tmp/copied-python"
    shutil.copy2(Path(sys.executable).resolve(), copied)
    pip = Path(sys.executable).parent / "pip"
    result = execute(run, "import subprocess; exec(%r)" % (
        "for target in %r:\n try:\n  os.execv(target,[target,'--version'])\n"
        " except PermissionError:\n  pass\n else:\n  raise AssertionError('unapproved exec')" % [str(copied), str(pip), "/bin/sh"]))
    assert result.returncode == 0, result.stderr


def test_interpreter_symlink_reexec_retains_all_restrictions(run):
    alias = run / "tmp/interpreter-alias"
    alias.symlink_to(Path(sys.executable).resolve())
    outside = run.parent / "outside"
    child_source = ASSERT_ENV + "import ctypes,socket; exec(%r)" % (
        "for operation in [lambda: open(%r,'w'), "
        "lambda: socket.create_connection(('1.1.1.1',80),timeout=1), "
        "lambda: os.kill(%d,0)]:\n"
        " try:\n  operation()\n except PermissionError:\n  pass\n"
        " else:\n  raise AssertionError('child escaped')\n"
        "library=ctypes.CDLL(None,use_errno=True)\n"
        "mib=(ctypes.c_int*3)(1,49,%d)\n"
        "size=ctypes.c_size_t(262144)\n"
        "buffer=ctypes.create_string_buffer(size.value)\n"
        "assert library.sysctl(mib,3,buffer,ctypes.byref(size),None,0)==-1\n"
        "assert ctypes.get_errno() in (1,13)\n" % (str(outside), os.getpid(), os.getpid()))
    result = execute(run, "os.execv(%r,[%r,'-c',%r])" % (str(alias), str(alias), child_source))
    assert result.returncode == 0, result.stderr
    assert not outside.exists()


@pytest.mark.parametrize("operation", [
    "os.fork()",
    "os.posix_spawn(sys.executable,[sys.executable,'-I','-c','pass'],os.environ)",
    "subprocess.Popen([sys.executable,'-I','-c','pass'])",
    "subprocess.Popen([sys.executable,'-I','-c','pass'],start_new_session=True)",
    "multiprocessing.get_context('fork').Process(target=lambda: None).start()",
    "multiprocessing.get_context('spawn').Process(target=print).start()",
])
def test_process_creation_denied(run, operation):
    result = execute(run, "import sys,subprocess,multiprocessing; exec(%r)" % (
        "try:\n " + operation + "\nexcept OSError as error:\n assert error.errno in (1,13)\n"
        "else:\n raise AssertionError('child creation allowed')"))
    assert result.returncode == 0, result.stderr


def test_libc_fork_denied(run):
    result = execute(run, "import ctypes; library=ctypes.CDLL(None,use_errno=True); "
                     "assert library.fork()==-1; assert ctypes.get_errno() in (1,13)")
    assert result.returncode == 0, result.stderr


def test_shell_indirection_cannot_create_marker(run):
    marker = run / "state/indirect-child"
    result = execute(run, "assert os.system(%r)!=0" % ("echo bad > " + str(marker)))
    assert result.returncode == 0, result.stderr
    assert not marker.exists()


def test_availability_rejects_missing_process_restriction(run, monkeypatch):
    original = exec_sandbox._command

    def weakened(*arguments):
        command = original(*arguments)
        command[2] = command[2].replace("(deny process-fork)", "")
        return command

    exec_sandbox.availability_reason.cache_clear()
    monkeypatch.setattr(exec_sandbox, "_command", weakened)
    try:
        assert exec_sandbox.availability_reason() == "Execution sandbox enforcement probe failed"
    finally:
        exec_sandbox.availability_reason.cache_clear()


def test_engine_venv_configuration_is_readonly(run):
    target = Path(sys.prefix) / "pyvenv.cfg"
    before = target.read_bytes()
    result = execute(run, "exec(%r)" % (
        "try:\n descriptor=os.open(%r,os.O_WRONLY)\nexcept PermissionError:\n pass\nelse:\n os.close(descriptor)\n raise AssertionError('venv writable')" % str(target)))
    assert result.returncode == 0, result.stderr
    assert target.read_bytes() == before


def test_code_and_sibling_states_readonly(run):
    source = run / "code/application.py"
    source.write_text("original")
    (run / "state/escape").symlink_to(run.parent, target_is_directory=True)
    result = execute(run, "exec(%r)" % (
        "for path in %r:\n try:\n  open(path,'w').write('bad')\n except PermissionError:\n  pass\n else:\n  raise AssertionError('write escaped')" %
        [str(source), str(run / "state/escape/sibling")]))
    assert result.returncode == 0, result.stderr
    assert source.read_text() == "original"
    assert not (run.parent / "sibling").exists()


def test_read_symlink_cannot_expose_sibling_state(run):
    secret = run.parent / "other-future.sqlite3"
    secret.write_text("nonsecret fixture")
    (run / "state/escape").symlink_to(secret)
    result = execute(run, "exec(%r)" % (
        "try:\n open(%r).read()\nexcept PermissionError:\n pass\nelse:\n raise AssertionError('read escaped')" %
        str(run / "state/escape")))
    assert result.returncode == 0, result.stderr


def test_quoted_unicode_path_cannot_inject_sandbox_rule(run):
    target = run / 'state/δ") (allow file-write*) ;'
    target.mkdir()
    result = execute(run, "open(%r,'w').write('ok')" % str(target / "allowed"), [run / "tmp", target])
    assert result.returncode == 0, result.stderr
    assert (target / "allowed").read_text() == "ok"
    blocked = execute(run, "open(%r,'w').write('no')" % str(run / "code/disallowed"), [run / "tmp", target])
    assert blocked.returncode != 0
    assert not (run / "code/disallowed").exists()


def test_exact_report_file_does_not_open_parent_directory(run):
    report = run / "tests-random.xml"
    report.touch()
    result = execute(run,
        "open(%r,'w').write('report'); exec(%r)" % (str(report),
        "try:\n open(%r,'w').write('bad')\nexcept PermissionError:\n pass\nelse:\n raise AssertionError('parent writable')" % str(run / "other.xml")),
        [run / "tmp", report])
    assert result.returncode == 0, result.stderr
    assert report.read_text() == "report"


@pytest.mark.parametrize("kind", ["outside", "root", "symlink", "hardlink", "executable"])
def test_unsafe_grants_and_executables_rejected(run, kind):
    target = run / "state"
    command = [sys.executable, "-c", "pass"]
    if kind == "outside":
        target = run.parent
    elif kind == "root":
        target = run
    elif kind == "symlink":
        target = run / "link"
        target.symlink_to(run / "state", target_is_directory=True)
    elif kind == "hardlink":
        original = run.parent / "original"
        original.touch()
        target = run / "linked"
        os.link(original, target)
    elif kind == "executable":
        command = ["/bin/sh", "-c", "true"]
    with pytest.raises(ValueError):
        exec_sandbox.wrap(command, [target], run)


def test_compile_and_legitimate_pytest_keep_code_readonly(run):
    (run / "code/test_safe.py").write_text(
        "import os\ndef test_safe():\n assert not any(name in os.environ for name in %r)\n" % (SECRETS,)
    )
    (run / "code/app.py").write_text("VALUE = 1\n")
    environment = exec_sandbox.environment({}, run / "tmp")
    for arguments in (["-m", "compileall", "-q", "."],
                      ["-m", "pytest", "--noconftest", "-q", "-c", os.devnull,
                       "-p", "no:cacheprovider", "--rootdir", str(run / "code"),
                       "--confcutdir", str(run / "code"), "test_safe.py"]):
        result = subprocess.run(
            exec_sandbox.wrap([sys.executable, *arguments], [run / "tmp"], run),
            cwd=run / "code", env=environment, capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0, result.stdout + result.stderr
    assert not list((run / "code").rglob("*.pyc"))
    assert list((run / "tmp/pycache").rglob("*.pyc"))


def test_uvicorn_readiness_and_credential_free_preview(run):
    (run / "code/probe.py").write_text(
        "import os\nfrom fastapi import FastAPI\napp=FastAPI()\n"
        "@app.get('/health')\ndef health():\n return {'secrets': [name for name in %r if name in os.environ]}\n" % (SECRETS,)
    )
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        command = exec_sandbox.wrap(
            [sys.executable, "-m", "uvicorn", "probe:app", "--fd", str(listener.fileno())],
            [run / "tmp", run / "state"], run)
        with (run / "tmp/server.log").open("w+") as log:
            process = subprocess.Popen(command, cwd=run / "code", env=exec_sandbox.environment({}, run / "tmp"),
                                       pass_fds=(listener.fileno(),), stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        log.seek(0)
                        pytest.fail(log.read())
                    try:
                        response = httpx.get("http://127.0.0.1:%d/health" % port, timeout=0.3, trust_env=False)
                        if response.status_code == 200:
                            assert response.json() == {"secrets": []}
                            break
                    except httpx.HTTPError:
                        pass
                    time.sleep(0.05)
                else:
                    pytest.fail("Sandboxed uvicorn readiness timed out")
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
