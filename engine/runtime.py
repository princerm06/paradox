import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import shutil
import tempfile
import threading
import time

import httpx

from engine.adapters.base import DEMO_PROFILE, ProjectProfile
from engine.adapters import exec_sandbox
from engine.jobs import scrubbed_environment


class Runtime:
    def __init__(self, root: Path, port: int = 8001, environment=None, control=None, profile: ProjectProfile = DEMO_PROFILE):
        self.root = root
        self.port = port
        self.process = None
        self.log = None
        self.environment = environment
        self.control = control
        self.profile = profile
        self.temporary = None
        self.log_thread = None

    @property
    def running(self):
        return self.process is not None and self.process.poll() is None

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}"

    def start(self):
        sandboxed = self.profile.execution == "sandboxed"
        if sandboxed:
            reason = exec_sandbox.availability_reason()
            if reason:
                raise RuntimeError("execution_sandbox_unavailable: " + reason)
        elif self.profile.execution != "trusted_local" or self.profile.adapter != DEMO_PROFILE.adapter:
            raise RuntimeError("execution_sandbox_unavailable: unsupported execution profile")
        if self.running:
            return
        listener = socket.socket()
        try:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", self.port))
            listener.listen(128)
            self.port = listener.getsockname()[1]
            environment = dict(self.environment) if self.environment is not None else scrubbed_environment()
            for name in ("FACTORY_API_KEY", "PARADOX_TOKEN", "PARADOX_SHELL_TOKEN", "ANTHROPIC_API_KEY"):
                environment.pop(name, None)
            environment.pop("PYTHONPATH", None)
            environment.update({
                self.profile.state_env: str(self.root / "workspace" / "state"),
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONUNBUFFERED": "1",
            })
            self.log = (self.root / "runtime.log").open("ab")
            launcher = (
                "import os,runpy,sys,threading; "
                "threading.Thread(target=lambda: (sys.stdin.buffer.read(), os._exit(0)), daemon=True).start(); "
                "sys.argv=['uvicorn',sys.argv[2],'--fd',sys.argv[1],'--log-level','warning']; "
                "runpy.run_module('uvicorn',run_name='__main__')"
            )
            command = [sys.executable, "-c", launcher, str(listener.fileno()), self.profile.app]
            if sandboxed:
                workspace = self.root / "workspace"
                self.temporary = Path(tempfile.mkdtemp(prefix=".runtime-", dir=workspace)).resolve()
                environment = exec_sandbox.environment(environment, self.temporary)
                launcher = (
                    "import os,sys,threading; sys.pycache_prefix=sys.argv[3]; import uvicorn; "
                    "threading.Thread(target=lambda: (os.read(0,1), os._exit(0)), daemon=True).start(); "
                    "sys.path.append(os.getcwd()); "
                    "uvicorn.run(sys.argv[2],fd=int(sys.argv[1]),log_level='warning',access_log=False)"
                )
                command = exec_sandbox.wrap(
                    [sys.executable, "-I", "-c", launcher, str(listener.fileno()), self.profile.app,
                     str(self.temporary / "pycache")],
                    [workspace / "state", self.temporary], workspace,
                )
            self.process = subprocess.Popen(
                command,
                cwd=self.root / "workspace" / "code",
                env=environment,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE if sandboxed else self.log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                pass_fds=(listener.fileno(),),
            )
            if sandboxed:
                self.log_thread = threading.Thread(target=self.capture_log, args=(self.process.stdout, self.log), daemon=True)
                self.log_thread.start()
        except BaseException:
            self.stop()
            raise
        finally:
            listener.close()
        try:
            with httpx.Client(trust_env=False, timeout=0.5) as client:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if self.control:
                        self.control.check()
                    if not self.running:
                        raise RuntimeError("Application exited; inspect runtime.log")
                    try:
                        response = client.get(self.url + self.profile.health_path)
                        if response.status_code == 200 and self.running:
                            return
                    except httpx.HTTPError:
                        pass
                    time.sleep(0.05)
            raise RuntimeError("Application health check timed out; inspect runtime.log")
        except BaseException:
            self.stop()
            raise

    @staticmethod
    def capture_log(source, destination):
        remaining = 4 * 1024 * 1024
        try:
            while True:
                chunk = os.read(source.fileno(), 65536)
                if not chunk:
                    return
                if remaining:
                    destination.write(chunk[:remaining])
                    destination.flush()
                    remaining = max(0, remaining - len(chunk))
        finally:
            source.close()

    def stop(self):
        if self.process is not None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            if self.running:
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(self.process.pid, signal.SIGKILL)
                    self.process.wait(timeout=5)
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            if self.process.stdin:
                self.process.stdin.close()
            self.process = None
        if self.log_thread:
            self.log_thread.join(timeout=5)
            self.log_thread = None
        if self.log:
            self.log.close()
            self.log = None
        if self.temporary is not None:
            shutil.rmtree(self.temporary, ignore_errors=True)
            self.temporary = None
