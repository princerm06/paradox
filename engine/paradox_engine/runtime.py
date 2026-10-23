from __future__ import annotations

import os
import signal
import socket
import subprocess
import time
from datetime import datetime, timezone

import httpx


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


class RuntimeFailure(Exception):
    pass


class Runtime:
    def __init__(self, settings):
        self.settings = settings
        self.directory = settings.home / "runtime"
        self.workspace = self.directory / "workspace"
        self.db = self.directory / "app.db"
        self.log = self.directory / "app.log"
        self.pid_file = self.directory / "app.pid"
        self.process = None
        self.timeline_id = None
        self.started_at = None
        self.status = "stopped"
        self.last_transition_ms = 0
        self.directory.mkdir(parents=True, exist_ok=True)

    def port_free(self):
        with socket.socket() as connection:
            return connection.connect_ex(("127.0.0.1", self.settings.app_port)) != 0

    def stop(self):
        pid = self.process.pid if self.process else None
        if pid is None and self.pid_file.exists():
            try:
                pid = int(self.pid_file.read_text())
            except ValueError:
                pass
        if pid:
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                if self.process:
                    self.process.poll()
                try:
                    os.killpg(pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.05)
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            if self.process:
                self.process.wait(timeout=3)
        self.process = None
        self.pid_file.unlink(missing_ok=True)
        self.status = "stopped"
        deadline = time.monotonic() + 3
        while not self.port_free():
            if time.monotonic() >= deadline:
                raise RuntimeFailure("Runtime port is still occupied\n" + "\n".join(self.tail(30)))
            time.sleep(0.05)

    def start(self, timeline_id):
        self.stop()
        started = time.monotonic()
        self.timeline_id = timeline_id
        self.status = "starting"
        environment = os.environ.copy()
        environment.update(APP_DB_PATH=str(self.db), PARADOX_TIMELINE_ID=timeline_id,
                           PARADOX_APP_PORT=str(self.settings.app_port), PYTHONDONTWRITEBYTECODE="1",
                           PYTHONPATH=str(self.workspace))
        command = [part.replace("{port}", str(self.settings.app_port)) for part in self.settings.app_command]
        with self.log.open("ab") as output:
            self.process = subprocess.Popen(command, cwd=self.workspace, env=environment,
                                            stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        self.pid_file.write_text(str(self.process.pid))
        self.started_at = timestamp()
        with httpx.Client(timeout=0.4, trust_env=False) as client:
            while time.monotonic() - started < self.settings.health_timeout:
                if self.process.poll() is not None:
                    break
                try:
                    response = client.get(self.url + self.settings.health_path)
                    payload = response.json()
                    if response.status_code == 200 and payload.get("ok") is True and payload.get("timeline_id") == timeline_id:
                        self.status = "running"
                        self.last_transition_ms = int((time.monotonic() - started) * 1000)
                        return
                except (httpx.HTTPError, ValueError):
                    pass
                time.sleep(0.05)
        self.stop()
        self.status = "crashed"
        raise RuntimeFailure("Runtime failed to become healthy\n" + "\n".join(self.tail(40)))

    @property
    def url(self):
        return "http://127.0.0.1:" + str(self.settings.app_port)

    def tail(self, count):
        if not self.log.exists() or count <= 0:
            return []
        return self.log.read_text(errors="replace").splitlines()[-count:]

    def info(self):
        if self.process and self.process.poll() is not None:
            self.status = "crashed"
        return {"status": self.status, "timeline_id": self.timeline_id, "url": self.url,
                "pid": self.process.pid if self.process and self.process.poll() is None else None,
                "started_at": self.started_at, "last_transition_ms": self.last_transition_ms}
