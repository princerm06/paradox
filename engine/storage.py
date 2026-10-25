from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import sqlite3
from uuid import uuid4

from engine.adapters.base import DEMO_PROFILE, ProjectProfile


def now():
    return datetime.now(timezone.utc).isoformat()


def copy_tree(source: Path, destination: Path):
    for entry in source.rglob("*"):
        if entry.is_symlink():
            raise ValueError("Symlinks are not supported in managed snapshots")
        if not entry.is_file() and not entry.is_dir():
            raise ValueError("Special files are not supported in managed snapshots")
    shutil.copytree(source, destination, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))


class Storage:
    def __init__(self, root: Path, profile: ProjectProfile = DEMO_PROFILE):
        self.root = root
        self.profile = profile
        self.workspace = root / "workspace"
        self.snapshots = root / "snapshots"
        self.snapshots.mkdir(exist_ok=True)
        self.connection = sqlite3.connect(root / "engine.sqlite3", check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS timelines (
                id TEXT PRIMARY KEY, parent_id TEXT REFERENCES timelines(id),
                name TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
                snapshot_id TEXT, modification TEXT, generation_id TEXT
            );
            CREATE TABLE IF NOT EXISTS snapshots (
                id TEXT PRIMARY KEY, timeline_id TEXT NOT NULL REFERENCES timelines(id),
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)
        columns = {row["name"] for row in self.connection.execute("PRAGMA table_info(timelines)")}
        if "modification" not in columns:
            with self.connection:
                self.connection.execute("ALTER TABLE timelines ADD COLUMN modification TEXT")
        if "generation_id" not in columns:
            with self.connection:
                self.connection.execute("ALTER TABLE timelines ADD COLUMN generation_id TEXT")

    def setting(self, key):
        row = self.connection.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def set_setting(self, key, value):
        self.connection.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (key, value))

    def timeline(self, timeline_id):
        row = self.connection.execute("SELECT * FROM timelines WHERE id=?", (timeline_id,)).fetchone()
        if row is None:
            raise KeyError("Timeline not found")
        return dict(row)

    def create_timeline(self, name, parent_id=None, timeline_id=None, modification=None):
        timeline_id = timeline_id or str(uuid4())
        with self.connection:
            self.connection.execute(
                "INSERT INTO timelines (id,parent_id,name,status,created_at,snapshot_id,modification) VALUES (?,?,?,?,?,NULL,?)",
                (timeline_id, parent_id, name, "pending" if parent_id else "confirmed", now(), modification),
            )
        return timeline_id

    def snapshot(self, timeline_id, update_head=True):
        snapshot_id = str(uuid4())
        temporary = self.snapshots / (snapshot_id + ".tmp")
        destination = self.snapshots / snapshot_id
        try:
            if self.profile.execution == "sandboxed":
                temporary.mkdir()
                for name in ("code", "state"):
                    copy_tree(self.workspace / name, temporary / name)
            else:
                copy_tree(self.workspace, temporary)
            state = self.workspace / "state"
            for pattern in self.profile.sqlite_state_globs:
                if Path(pattern).is_absolute() or ".." in Path(pattern).parts:
                    raise ValueError("SQLite state patterns must stay within the state directory")
            databases = sorted({path for pattern in self.profile.sqlite_state_globs for path in state.glob(pattern)})
            for database in databases:
                if not database.is_file():
                    raise ValueError("Declared SQLite state must be a regular file")
                target = temporary / "state" / database.relative_to(state)
                target.unlink(missing_ok=True)
                with closing(sqlite3.connect(database)) as source, closing(sqlite3.connect(target)) as output:
                    source.backup(output)
                for suffix in ("-wal", "-shm", "-journal"):
                    Path(str(target) + suffix).unlink(missing_ok=True)
            temporary.rename(destination)
            record = {"id": snapshot_id, "timeline_id": timeline_id, "created_at": now()}
            with self.connection:
                self.connection.execute("INSERT INTO snapshots VALUES (:id,:timeline_id,:created_at)", record)
                if update_head:
                    self.connection.execute("UPDATE timelines SET snapshot_id=? WHERE id=?", (snapshot_id, timeline_id))
            return record
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)

    def restore(self, snapshot_id):
        if self.connection.execute("SELECT 1 FROM snapshots WHERE id=?", (snapshot_id,)).fetchone() is None:
            raise KeyError("Snapshot not found")
        self.materialize(self.snapshots / snapshot_id)

    def materialize(self, source):
        temporary = self.root / "workspace.staging"
        if temporary.exists():
            shutil.rmtree(temporary)
        copy_tree(source, temporary)
        if self.workspace.exists():
            shutil.rmtree(self.workspace)
        temporary.rename(self.workspace)

    def initialize_workspace(self, demo_source):
        if self.profile.adapter != DEMO_PROFILE.adapter:
            from engine.adapters.fastapi_sqlite import ADAPTER
            if self.profile.adapter != ADAPTER.id or self.profile.execution != "sandboxed":
                raise ValueError("Unsupported imported project profile")
            self.workspace.mkdir(exist_ok=True)
            copy_tree(demo_source, self.workspace / "code")
            ADAPTER.initialize_state(self.workspace / "state")
            return
        self.workspace.mkdir(exist_ok=True)
        code = self.workspace / "code"
        code.mkdir(exist_ok=True)
        package = self.profile.app.split(":", 1)[0].split(".", 1)[0]
        copy_tree(demo_source, code / package)
        state = self.workspace / "state"
        state.mkdir()
        initial = demo_source / "behavior.json"
        if initial.exists():
            shutil.copy2(initial, state / "behavior.json")
        else:
            (state / "behavior.json").write_text(json.dumps({"feed_order": "chronological"}))
