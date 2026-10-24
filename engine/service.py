import fcntl
import json
from pathlib import Path
import shutil
import threading
from uuid import uuid4

from engine.runtime import Runtime
from engine.storage import Storage


class Conflict(Exception):
    pass


class Unavailable(Exception):
    pass


class Gate:
    def __init__(self):
        self.lock = threading.RLock()

    def __enter__(self):
        if not self.lock.acquire(timeout=30):
            raise Unavailable("Engine is busy; retry after the current transition")
        return self

    def __exit__(self, *arguments):
        self.lock.release()


class Engine:
    def __init__(self, root: Path, demo_source: Path, runtime_port: int):
        self.root = root.resolve()
        self.demo_source = demo_source.resolve()
        self.gate = Gate()
        self.lock_file = None
        self.storage = None
        self.runtime = Runtime(self.root, runtime_port)

    @property
    def active_id(self):
        return self.storage.setting("active_id")

    def view(self, timeline_id):
        timeline = self.storage.timeline(timeline_id)
        timeline["is_active"] = timeline_id == self.active_id
        return timeline

    def start(self):
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock_file = (self.root / "engine.lock").open("a+")
        try:
            fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock_file.close()
            self.lock_file = None
            raise RuntimeError("State directory is already owned by another engine")
        try:
            self.storage = Storage(self.root)
            if self.active_id is None:
                with self.storage.connection:
                    self.storage.connection.execute("DELETE FROM snapshots")
                    self.storage.connection.execute("DELETE FROM timelines")
                if self.storage.workspace.exists():
                    shutil.rmtree(self.storage.workspace)
                self.storage.initialize_workspace(self.demo_source)
                self.runtime.start()
                timeline_id = self.storage.create_timeline("Original")
                self.storage.snapshot(timeline_id)
                with self.storage.connection:
                    self.storage.set_setting("active_id", timeline_id)
            else:
                recovery = self.storage.setting("transition")
                database = self.storage.workspace / "state" / "app.sqlite3"
                missing_database = not database.is_file() or database.stat().st_size == 0
                if recovery or missing_database or not (self.storage.workspace / "code" / "demo_app" / "main.py").is_file():
                    marker = json.loads(recovery) if recovery else {}
                    snapshot_id = marker.get("snapshot_id") or self.storage.timeline(self.active_id)["snapshot_id"]
                    self.storage.restore(snapshot_id)
                    with self.storage.connection:
                        if marker.get("child_id"):
                            self.storage.connection.execute("DELETE FROM snapshots WHERE timeline_id=?", (marker["child_id"],))
                            self.storage.connection.execute("DELETE FROM timelines WHERE id=?", (marker["child_id"],))
                        self.storage.connection.execute("DELETE FROM settings WHERE key='transition'")
                self.runtime.start()
        except BaseException:
            self.close(checkpoint=False)
            raise

    def close(self, checkpoint=True):
        try:
            with self.gate:
                self.runtime.stop()
                if checkpoint and self.storage and self.active_id and not self.storage.setting("transition"):
                    self.storage.snapshot(self.active_id)
        finally:
            if self.storage:
                self.storage.connection.close()
                self.storage = None
            if self.lock_file:
                self.lock_file.close()
                self.lock_file = None

    def require_available(self, timeline_id):
        timeline = self.storage.timeline(timeline_id)
        if timeline["status"] == "declined":
            raise Conflict("Declined timelines cannot be activated or changed")
        return timeline

    def checkpoint(self):
        self.runtime.stop()
        try:
            return self.storage.snapshot(self.active_id)
        finally:
            self.runtime.start()

    def transition(self, target_id=None, snapshot_id=None, name=None, modification="none", decline_id=None, parent_id=None):
        previous_id = self.active_id
        child_id = str(uuid4()) if name is not None else None
        self.runtime.stop()
        try:
            outgoing = self.storage.snapshot(previous_id)
        except Exception as error:
            self.runtime.start()
            raise Unavailable("Could not checkpoint outgoing timeline") from error
        with self.storage.connection:
            self.storage.set_setting("transition", json.dumps({"snapshot_id": outgoing["id"], "child_id": child_id}))
        try:
            if name is not None:
                parent_id = previous_id if parent_id is None else parent_id
                parent_snapshot = outgoing["id"] if parent_id == previous_id else self.storage.timeline(parent_id)["snapshot_id"]
                self.storage.create_timeline(name, parent_id, child_id, modification=modification)
                target_id = child_id
                self.storage.restore(parent_snapshot)
                if modification == "popular_feed":
                    ranking = self.storage.workspace / "code" / "demo_app" / "ranking.py"
                    if not ranking.is_file():
                        raise ValueError("Demo source must expose demo_app/ranking.py")
                    template = Path(__file__).with_name("templates") / "popular_ranking.py"
                    ranking.write_bytes(template.read_bytes())
            else:
                self.storage.restore(snapshot_id or self.storage.timeline(target_id)["snapshot_id"])
            self.runtime.start()
            restored_snapshot = None
            if child_id or snapshot_id:
                self.runtime.stop()
                restored_snapshot = self.storage.snapshot(target_id, update_head=False)
                self.runtime.start()
            with self.storage.connection:
                if restored_snapshot:
                    self.storage.connection.execute("UPDATE timelines SET snapshot_id=? WHERE id=?", (restored_snapshot["id"], target_id))
                self.storage.set_setting("active_id", target_id)
                if decline_id:
                    self.storage.connection.execute("UPDATE timelines SET status='declined' WHERE id=?", (decline_id,))
                self.storage.connection.execute("DELETE FROM settings WHERE key='transition'")
            return self.view(target_id)
        except Exception as error:
            self.runtime.stop()
            try:
                self.storage.restore(outgoing["id"])
                self.runtime.start()
                with self.storage.connection:
                    self.storage.set_setting("active_id", previous_id)
                    self.storage.connection.execute("DELETE FROM settings WHERE key='transition'")
                    if child_id:
                        self.storage.connection.execute("DELETE FROM snapshots WHERE timeline_id=?", (child_id,))
                        self.storage.connection.execute("DELETE FROM timelines WHERE id=?", (child_id,))
            except Exception as rollback_error:
                raise Unavailable("Transition and rollback failed; restart engine to recover") from rollback_error
            raise Unavailable("Transition failed; previous timeline restored. Inspect runtime.log") from error

    def activate(self, timeline_id):
        self.require_available(timeline_id)
        if timeline_id == self.active_id:
            if not self.runtime.running:
                self.runtime.start()
            return self.view(timeline_id)
        return self.transition(target_id=timeline_id)

    def sprout(self, name, modification, parent_id=None):
        parent_id = self.active_id if parent_id is None else parent_id
        self.require_available(parent_id)
        return self.transition(name=name, modification=modification, parent_id=parent_id)

    def decide(self, timeline_id, status):
        timeline = self.storage.timeline(timeline_id)
        if timeline["status"] == status:
            return self.view(timeline_id)
        if timeline["parent_id"] is None or timeline["status"] != "pending":
            raise Conflict("Only pending sprouts can be confirmed or declined")
        if status == "declined" and timeline_id == self.active_id:
            ancestor = self.storage.timeline(timeline["parent_id"])
            while ancestor["status"] == "declined":
                ancestor = self.storage.timeline(ancestor["parent_id"])
            self.transition(target_id=ancestor["id"], decline_id=timeline_id)
        else:
            with self.storage.connection:
                self.storage.connection.execute("UPDATE timelines SET status=? WHERE id=?", (status, timeline_id))
        return self.view(timeline_id)

    def restore(self, timeline_id, snapshot_id):
        self.require_available(timeline_id)
        row = self.storage.connection.execute(
            "SELECT 1 FROM snapshots WHERE id=? AND timeline_id=?", (snapshot_id, timeline_id)
        ).fetchone()
        if row is None:
            raise KeyError("Snapshot not found in this timeline")
        return self.transition(target_id=timeline_id, snapshot_id=snapshot_id)
