from __future__ import annotations

import fnmatch
import os
import shutil
import sqlite3
import subprocess
from pathlib import Path


def backup_db(source: Path, destination: Path):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(str(source)) as source_db:
        with sqlite3.connect(str(destination)) as destination_db:
            source_db.backup(destination_db)


def restore_db(source: Path, destination: Path):
    for suffix in ("", "-wal", "-shm", "-journal"):
        Path(str(destination) + suffix).unlink(missing_ok=True)
    backup_db(source, destination)


def excluded(directory, names):
    return [name for name in names if name in {"__pycache__", "tests", ".pytest_cache", ".git"} or fnmatch.fnmatch(name, "*.pyc") or fnmatch.fnmatch(name, "*.db*")]


class CodeStore:
    def __init__(self, home: Path):
        self.home = home
        self.repo = home / "code.git"
        self.environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        self.environment.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                                GIT_AUTHOR_NAME="Paradox", GIT_AUTHOR_EMAIL="paradox@localhost",
                                GIT_COMMITTER_NAME="Paradox", GIT_COMMITTER_EMAIL="paradox@localhost")
        if not self.repo.exists():
            self.run(home, "init", "--bare", str(self.repo))
        (self.repo / "info" / "exclude").write_text("__pycache__/\n*.pyc\n*.db*\ntests/\n.pytest_cache/\n")

    def run(self, workspace: Path, *arguments: str) -> bytes:
        result = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
                                 "-c", "core.autocrlf=false", "-c", "core.excludesFile=/dev/null",
                                 "--git-dir=" + str(self.repo), "--work-tree=" + str(workspace), *arguments],
                                env=self.environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode:
            raise RuntimeError(result.stderr.decode(errors="replace"))
        return result.stdout

    def commit(self, workspace: Path, timeline_id: str) -> str:
        self.run(workspace, "add", "-A")
        self.run(workspace, "commit", "--allow-empty", "-m", "Paradox snapshot")
        reference = self.run(workspace, "rev-parse", "HEAD").decode().strip()
        self.run(workspace, "update-ref", "refs/paradox/" + timeline_id, reference)
        return reference

    def materialize(self, reference: str, workspace: Path):
        if workspace.exists():
            shutil.rmtree(workspace)
        workspace.mkdir(parents=True)
        self.run(workspace, "read-tree", reference)
        self.run(workspace, "checkout-index", "--all", "--force")

    def diff(self, base: str, target: str):
        raw = self.run(self.home, "diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", base, target).decode()
        parts = raw.split("\0")
        files = []
        for index in range(0, len(parts) - 1, 2):
            status, path = parts[index:index + 2]
            patch = self.run(self.home, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", base, target, "--", path).decode(errors="replace")
            files.append({"path": path, "status": {"A": "added", "D": "deleted"}.get(status, "modified"), "patch": patch})
        return files
