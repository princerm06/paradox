from datetime import datetime, timezone
from pathlib import Path
import secrets
import threading

from engine.repositories.git import Git, RepositoryError


class Registry:
    def __init__(self, roots, state_dir):
        self.entries = {}
        self.lock = threading.RLock()
        self.git = Git()
        self.state_dir = Path(state_dir).resolve()
        self.checkout = Path(__file__).resolve().parents[2]
        for root in roots:
            self.register(str(root), "configured")

    def register(self, value, source="picker"):
        path = Path(value)
        if not path.is_absolute() or ".." in path.parts or "\x00" in value:
            raise RepositoryError("unsafe_path", "Use an absolute directory without parent traversal", 400)
        try:
            root = path.resolve(strict=True)
        except (OSError, ValueError, RuntimeError) as error:
            raise RepositoryError("invalid_path", "Repository directory does not exist", 400) from error
        if not root.is_dir():
            raise RepositoryError("invalid_path", "Repository path must be a directory", 400)
        if root in {Path(root.anchor), Path.home().resolve(), self.checkout} or root == self.state_dir or self.state_dir in root.parents:
            raise RepositoryError("unsafe_path", "This directory cannot be registered", 400)
        metadata = root / ".git"
        if metadata.is_symlink() or not metadata.is_dir():
            raise RepositoryError("unsupported_git_layout", "A standalone Git working-tree root is required")
        for name in ("config", "HEAD", "index", "commondir"):
            if (metadata / name).is_symlink():
                raise RepositoryError("unsafe_git_metadata", "Symlink Git metadata is unsupported")
        self.git.inspect(root)
        with self.lock:
            for entry in self.entries.values():
                if entry["root"] == str(root):
                    raise RepositoryError("already_registered", "Already registered: " + entry["id"], 409)
            entry = {"id": secrets.token_urlsafe(9), "name": root.name, "root": str(root), "source": source,
                     "registered_at": datetime.now(timezone.utc).isoformat()}
            self.entries[entry["id"]] = entry
            return dict(entry)

    def get(self, repository_id):
        with self.lock:
            if repository_id not in self.entries:
                raise RepositoryError("unknown_repository", "Unknown repository id", 404)
            return dict(self.entries[repository_id])

    def listing(self):
        with self.lock:
            return [dict(entry) for entry in self.entries.values()]

    def forget(self, repository_id):
        with self.lock:
            self.get(repository_id)
            del self.entries[repository_id]
