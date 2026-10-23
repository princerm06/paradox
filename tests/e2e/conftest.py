"""Out-of-process acceptance harness for Fork.

Each test gets a real engine running as a separate uvicorn process, with its own
state dir and ports. Tests talk to it only over HTTP, just like the frontend.
The OS is the only other thing they look at (to find or kill the app runtime
process), plus the documented workspace layout for checking code-level changes.
"""
from __future__ import annotations

import hashlib
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

import httpx
import pytest

REPO = Path(__file__).resolve().parents[2]
DEMO_SOURCE = REPO / "demo_app"

LAUNCHER = (
    "import sys, uvicorn; from engine.api import create_app; "
    "uvicorn.run(create_app(state_dir=sys.argv[1], runtime_port=0), "
    "host='127.0.0.1', port=int(sys.argv[2]), log_level='warning')"
)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def child_pids(pid: int) -> List[int]:
    out = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True).stdout
    return [int(p) for p in out.split()]


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def tree_digest(root: Path) -> Dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*"))
        if p.is_file() and "__pycache__" not in p.parts
    }


class Engine:
    """A running engine process plus HTTP helpers that follow the contract."""

    def __init__(self, state_dir: Path, log_path: Path):
        self.state_dir = state_dir
        self.log_path = log_path
        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.proc: Optional[subprocess.Popen] = None
        self.http = httpx.Client(base_url=self.base, trust_env=False, timeout=30)

    # lifecycle -----------------------------------------------------------
    def start(self, timeout: float = 30) -> None:
        env = os.environ.copy()
        env["PYTHONPATH"] = str(REPO)
        self._log = self.log_path.open("ab")
        self.proc = subprocess.Popen(
            [sys.executable, "-c", LAUNCHER, str(self.state_dir), str(self.port)],
            cwd=REPO, env=env, stdout=self._log, stderr=subprocess.STDOUT,
        )
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"engine exited early:\n{self.log_tail()}")
            try:
                if self.http.get("/api/health").status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.1)
        raise RuntimeError(f"engine not healthy in {timeout}s:\n{self.log_tail()}")

    def stop(self, sig: int = signal.SIGTERM) -> None:
        if self.proc is None:
            return
        app_pids = child_pids(self.proc.pid)
        if self.proc.poll() is None:
            self.proc.send_signal(sig)
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        # The runtime has its own session. It should exit on engine shutdown or
        # stdin EOF, but make sure nothing is left behind.
        deadline = time.monotonic() + 5
        for pid in app_pids:
            while pid_alive(pid) and time.monotonic() < deadline:
                time.sleep(0.05)
            if pid_alive(pid):
                os.kill(pid, signal.SIGKILL)
        self.proc = None
        self._log.close()

    def log_tail(self, n: int = 60) -> str:
        lines = self.log_path.read_text(errors="replace").splitlines() if self.log_path.exists() else []
        runtime_log = self.state_dir / "runtime.log"
        if runtime_log.exists():
            lines += ["--- runtime.log ---"] + runtime_log.read_text(errors="replace").splitlines()
        return "\n".join(lines[-n:])

    # runtime process introspection (OS-level) -----------------------------
    def app_pid(self) -> int:
        pids = child_pids(self.proc.pid)
        assert len(pids) == 1, f"expected exactly one runtime process, found {pids}"
        return pids[0]

    # engine API ----------------------------------------------------------
    def call(self, method: str, path: str, expect: int = 200, **kw) -> dict:
        r = self.http.request(method, path, **kw)
        assert r.status_code == expect, f"{method} {path} -> {r.status_code}: {r.text}\n{self.log_tail()}"
        return r.json() if r.content else {}

    def listing(self) -> dict:
        return self.call("GET", "/api/timelines")

    def timelines(self) -> Dict[str, dict]:
        return {t["id"]: t for t in self.listing()["timelines"]}

    def active_id(self) -> str:
        return self.listing()["active_timeline_id"]

    def root_id(self) -> str:
        roots = [t for t in self.listing()["timelines"] if t["parent_id"] is None]
        assert len(roots) == 1
        return roots[0]["id"]

    def sprout(self, name: str, modification: str = "popular_feed", **extra) -> dict:
        return self.call("POST", "/api/timelines/sprout", expect=201,
                         json={"name": name, "modification": modification, **extra})

    def activate(self, tid: str) -> dict:
        t = self.call("POST", f"/api/timelines/{tid}/activate")
        assert t["id"] == tid and t["is_active"] is True
        return t

    # demo app through the engine proxy -----------------------------------
    def feed(self) -> dict:
        return self.call("GET", "/app/api/posts")

    def contents(self) -> List[str]:
        return [p["content"] for p in self.feed()["posts"]]

    def likes(self) -> Dict[str, int]:
        return {p["content"]: p["likes"] for p in self.feed()["posts"]}

    def post(self, content: str, author: str = "e2e") -> dict:
        return self.call("POST", "/app/api/posts", expect=201, json={"author": author, "content": content})

    def like(self, post_id: int) -> dict:
        return self.call("POST", f"/app/api/posts/{post_id}/like")

    def post_id(self, content: str) -> int:
        return next(p["id"] for p in self.feed()["posts"] if p["content"] == content)

    # documented workspace layout (contract: workspace/code/demo_app, workspace/state)
    @property
    def workspace_code(self) -> Path:
        return self.state_dir / "workspace" / "code" / "demo_app"

    @property
    def workspace_state(self) -> Path:
        return self.state_dir / "workspace" / "state"


@pytest.fixture
def engine_factory(tmp_path):
    engines: List[Engine] = []

    def make(state_dir: Optional[Path] = None) -> Engine:
        e = Engine(state_dir or tmp_path / "state", tmp_path / f"engine{len(engines)}.log")
        engines.append(e)
        e.start()
        return e

    yield make
    for e in engines:
        e.stop()
        e.http.close()


@pytest.fixture
def fork(engine_factory) -> Engine:
    return engine_factory()

