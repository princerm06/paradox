from datetime import datetime, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import secrets
import threading

from engine.repositories.git import Git, RepositoryError
from engine.repositories.persistence import RepositoryStore


class Registry:
    def __init__(self, roots, state_dir):
        self.entries = {}
        self.configurations = {}
        self.trusts = {}
        self.on_revoke = lambda repository_id: None
        self.trusted_roots = {str(Path(root).resolve()) for root in
                              filter(None, os.environ.get("PARADOX_TRUSTED_REPOSITORY_ROOTS", "").split(os.pathsep))}
        self.lock = threading.RLock()
        self.git = Git()
        self.state_dir = Path(state_dir).resolve()
        self.checkout = Path(__file__).resolve().parents[2]
        self.roots = roots
        self.store = RepositoryStore(self.state_dir)
        self.writable = True

    def start(self):
        from engine.repositories.inspection import validate
        try:
            registrations = self.store.load()
        except RepositoryError as error:
            self.writable = False
            logging.getLogger(__name__).warning("Repository registry unavailable: %s", error.code)
            return
        for registration in registrations:
            entry = registration.repository.model_dump()
            self.entries[entry["id"]] = entry
            if registration.configuration is not None:
                self.configurations[entry["id"]] = registration.configuration.model_dump()
            if registration.trust is not None:
                self.trusts[entry["id"]] = registration.trust.model_dump()
        for repository_id in self.entries:
            try:
                result = validate(self, repository_id, None, persist=False)
                if not result["valid"]:
                    logging.getLogger(__name__).warning("Repository compatibility changed: compatibility_invalid")
                elif self.entries[repository_id]["root"] in self.trusted_roots:
                    self.grant_trust(repository_id)
            except RepositoryError as error:
                logging.getLogger(__name__).warning("Registered repository unavailable: %s", error.code)
            except (OSError, RuntimeError):
                logging.getLogger(__name__).warning("Registered repository unavailable: repository_unavailable")
        for root in self.roots:
            try:
                self.register(str(root), "configured")
            except RepositoryError as error:
                if error.code != "already_registered":
                    logging.getLogger(__name__).warning("Configured repository skipped: %s", error.code)
            except (OSError, RuntimeError):
                logging.getLogger(__name__).warning("Configured repository skipped: repository_unavailable")

    def check_path(self, value):
        path = Path(value)
        if not path.is_absolute() or ".." in path.parts or "\x00" in value:
            raise RepositoryError("unsafe_path", "Use an absolute directory without parent traversal", 400)
        try:
            root = path.resolve(strict=True)
        except (OSError, ValueError, RuntimeError) as error:
            raise RepositoryError("invalid_path", "Repository directory does not exist", 400) from error
        if root in {Path(root.anchor), Path.home().resolve(), self.checkout} or root == self.state_dir or self.state_dir in root.parents or root in self.state_dir.parents:
            raise RepositoryError("unsafe_path", "This directory cannot be registered", 400)
        try:
            if not root.is_dir():
                raise RepositoryError("invalid_path", "Repository path must be a directory", 400)
            metadata = root / ".git"
            if metadata.is_symlink() or not metadata.is_dir():
                raise RepositoryError("unsupported_git_layout", "A standalone Git working-tree root is required")
            for name in ("config", "HEAD", "index", "commondir"):
                if (metadata / name).is_symlink():
                    raise RepositoryError("unsafe_git_metadata", "Symlink Git metadata is unsupported")
        except OSError as error:
            raise RepositoryError("invalid_repository", "Repository permissions do not permit inspection") from error
        return root

    def register(self, value, source="picker"):
        root = self.check_path(value)
        self.git.inspect(root)
        with self.lock:
            for entry in self.entries.values():
                if entry["root"] == str(root):
                    raise RepositoryError("already_registered", "Already registered: " + entry["id"], 409)
            entry = {"id": secrets.token_urlsafe(9), "name": root.name, "root": str(root), "source": source,
                     "registered_at": datetime.now(timezone.utc).isoformat()}
            updated = {**self.entries, entry["id"]: entry}
            self.persist(updated, self.configurations)
            self.entries = updated
            return dict(entry)

    def checked_root(self, repository_id):
        value = self.get(repository_id)["root"]
        try:
            root = self.check_path(value)
        except RepositoryError as error:
            raise RepositoryError("repository_unavailable", "Registered repository path is unavailable or unsafe") from error
        if str(root) != value:
            raise RepositoryError("repository_unavailable", "Registered repository location changed")
        return root

    def configuration(self, repository_id):
        with self.lock:
            self.get(repository_id)
            value = self.configurations.get(repository_id)
            return dict(value) if value else None

    def save_configuration(self, repository_id, configuration):
        revoked = False
        with self.lock:
            self.get(repository_id)
            updated = {**self.configurations, repository_id: configuration}
            previous = self.configurations.get(repository_id)
            revoked = previous is not None and previous != configuration
            prior_trusts = self.trusts
            if revoked:
                self.trusts = {key: value for key, value in self.trusts.items() if key != repository_id}
            try:
                self.persist(self.entries, updated)
            except BaseException:
                self.trusts = prior_trusts
                raise
            self.configurations = updated
            if previous is None and self.entries[repository_id]["root"] in self.trusted_roots:
                self.grant_trust(repository_id)
        if revoked:
            self.on_revoke(repository_id)

    def persist(self, entries, configurations):
        if not self.writable:
            raise RepositoryError("registry_unavailable", "Repository registry needs repair before changes", 503)
        self.store.save(entries, configurations, self.trusts)

    def configuration_hash(self, repository_id):
        configuration = self.configuration(repository_id)
        if configuration is None:
            raise RepositoryError("validation_required", "Validate a project configuration before granting trust")
        return hashlib.sha256(json.dumps(configuration, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    def is_trusted(self, repository_id):
        with self.lock:
            trust = self.trusts.get(repository_id)
            return bool(trust and trust["configuration_hash"] == self.configuration_hash(repository_id))

    def grant_trust(self, repository_id):
        with self.lock:
            digest = self.configuration_hash(repository_id)
            previous = self.trusts
            self.trusts = {**previous, repository_id: {
                "repository_id": repository_id, "configuration_hash": digest,
                "granted_at": datetime.now(timezone.utc).isoformat(),
                "source": "configured" if self.entries[repository_id]["root"] in self.trusted_roots else "picker"}}
            try:
                self.persist(self.entries, self.configurations)
            except BaseException:
                self.trusts = previous
                raise
            return dict(self.trusts[repository_id])

    def revoke_trust(self, repository_id):
        with self.lock:
            self.get(repository_id)
            previous = self.trusts
            self.trusts = {key: value for key, value in previous.items() if key != repository_id}
            try:
                self.persist(self.entries, self.configurations)
            except BaseException:
                self.trusts = previous
                raise
        self.on_revoke(repository_id)

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
            entries = {key: value for key, value in self.entries.items() if key != repository_id}
            configurations = {key: value for key, value in self.configurations.items() if key != repository_id}
            previous = self.trusts
            self.trusts = {key: value for key, value in previous.items() if key != repository_id}
            try:
                self.persist(entries, configurations)
            except BaseException:
                self.trusts = previous
                raise
            self.entries = entries
            self.configurations = configurations
        self.on_revoke(repository_id)
