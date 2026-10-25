from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import pytest

from engine.jobs import Cancelled, JobControl, scrubbed_environment


CHILD = """
import os,signal,sys,time
from pathlib import Path
signal.signal(signal.SIGTERM,signal.SIG_IGN)
Path(sys.argv[1]).write_text(str(os.getpid()))
while True:
 with Path(sys.argv[2]).open('a') as output: output.write('write\\n')
 time.sleep(.02)
"""


def parent_source(directory, complete):
    return (
        "import subprocess,sys,time; from pathlib import Path; "
        "subprocess.Popen([sys.executable,'-I','-c',%r,%r,%r]); "
        "\nwhile not Path(%r).exists(): time.sleep(.01)\n" % (
            CHILD, str(directory / "pid"), str(directory / "writes"), str(directory / "pid"))
        + ("raise SystemExit(0)" if complete else "time.sleep(60)")
    )


def wait_for_file(path):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if path.is_file():
            return int(path.read_text())
        time.sleep(.02)
    raise AssertionError("Mock SDK child did not start")


def assert_stopped(pid, marker):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        result = subprocess.run(["/bin/ps", "-o", "stat=", "-p", str(pid)],
                                capture_output=True, text=True, env=scrubbed_environment())
        if result.returncode or result.stdout.strip().startswith("Z"):
            break
        time.sleep(.05)
    else:
        raise AssertionError("Trusted agent session descendant survived cleanup")
    before = marker.read_bytes() if marker.exists() else b""
    time.sleep(.15)
    assert (marker.read_bytes() if marker.exists() else b"") == before


@pytest.mark.parametrize("mode", ["complete", "cancel", "timeout"])
def test_session_descendant_cannot_outlive_trusted_agent(tmp_path, mode):
    control = JobControl()
    pid = None
    with ThreadPoolExecutor(max_workers=1) as executor:
        result = executor.submit(control.run, [sys.executable, "-I", "-c", parent_source(tmp_path, mode == "complete")],
                                 tmp_path, tmp_path / "agent.log", 1 if mode == "timeout" else 20)
        try:
            pid = wait_for_file(tmp_path / "pid")
            if mode == "cancel":
                control.cancel()
            if mode == "complete":
                assert result.result(timeout=10) == 0
            else:
                with pytest.raises(Cancelled if mode == "cancel" else TimeoutError):
                    result.result(timeout=10)
            assert_stopped(pid, tmp_path / "writes")
        finally:
            control.cancel()
            if pid is not None:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


def test_engine_exit_cleans_trusted_agent_session_descendant(tmp_path):
    source = (
        "import os,sys,threading,time; from pathlib import Path; "
        "sys.path.insert(0,%r); from engine.jobs import JobControl; "
        "threading.Thread(target=lambda: JobControl().run(%r,Path(%r),Path(%r),60)).start(); "
        "\nwhile not Path(%r).exists(): time.sleep(.01)\nos._exit(0)"
    ) % (str(Path(__file__).resolve().parents[1]),
         [sys.executable, "-I", "-c", parent_source(tmp_path, False)],
         str(tmp_path), str(tmp_path / "agent.log"), str(tmp_path / "pid"))
    process = subprocess.Popen([sys.executable, "-I", "-c", source], cwd=tmp_path,
                               env=scrubbed_environment(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    pid = None
    try:
        pid = wait_for_file(tmp_path / "pid")
        assert process.wait(timeout=10) == 0
        assert_stopped(pid, tmp_path / "writes")
    finally:
        process.kill() if process.poll() is None else None
        process.wait(timeout=5)
        if pid is not None:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
