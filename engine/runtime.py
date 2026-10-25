import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

import httpx

from engine.jobs import scrubbed_environment


class Runtime:
    def __init__(self, root: Path, port: int = 8001, environment=None, control=None):
        self.root = root
        self.port = port
        self.process = None
        self.log = None
        self.environment = environment
        self.control = control

    @property
    def running(self):
        return self.process is not None and self.process.poll() is None

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}"

    def start(self):
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
            environment.update(
                PARADOX_APP_DIR=str(self.root / "workspace" / "state"),
                PYTHONDONTWRITEBYTECODE="1",
                PYTHONUNBUFFERED="1",
            )
            self.log = (self.root / "runtime.log").open("ab")
            launcher = (
                "import os,runpy,sys,threading; "
                "threading.Thread(target=lambda: (sys.stdin.buffer.read(), os._exit(0)), daemon=True).start(); "
                "sys.argv=['uvicorn','demo_app.main:app','--fd',sys.argv[1],'--log-level','warning']; "
                "runpy.run_module('uvicorn',run_name='__main__')"
            )
            self.process = subprocess.Popen(
                [sys.executable, "-c", launcher, str(listener.fileno())],
                cwd=self.root / "workspace" / "code",
                env=environment,
                stdin=subprocess.PIPE,
                stdout=self.log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                pass_fds=(listener.fileno(),),
            )
        except BaseException:
            if self.log:
                self.log.close()
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
                        response = client.get(self.url + "/health")
                        if response.status_code == 200 and self.running:
                            return
                    except httpx.HTTPError:
                        pass
                    time.sleep(0.05)
            raise RuntimeError("Application health check timed out; inspect runtime.log")
        except BaseException:
            self.stop()
            raise

    def stop(self):
        if self.process is not None:
            if self.running:
                os.killpg(self.process.pid, signal.SIGTERM)
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(self.process.pid, signal.SIGKILL)
                    self.process.wait(timeout=5)
            if self.process.stdin:
                self.process.stdin.close()
            self.process = None
        if self.log:
            self.log.close()
            self.log = None
