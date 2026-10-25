import json
import os
from pathlib import Path
import stat
import tempfile
from typing import List, Literal, Optional

from pydantic import Field, ValidationError

from engine.repositories.git import RepositoryError
from engine.repositories.models import AdapterConfig, StrictModel


MAX_BYTES = 1024 * 1024


class Summary(StrictModel):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{12}$")
    name: str
    root: str
    source: Literal["configured", "picker"]
    registered_at: str


class RepositoryTrust(StrictModel):
    repository_id: str
    configuration_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    granted_at: str
    source: Literal["picker", "configured"]


class StoredRegistration(StrictModel):
    repository: Summary
    configuration: Optional[AdapterConfig] = None
    trust: Optional[RepositoryTrust] = None


class Document(StrictModel):
    schema_version: Literal[1]
    repositories: List[StoredRegistration]


class RepositoryStore:
    def __init__(self, state_dir):
        self.path = Path(state_dir) / "repositories.json"

    def load(self):
        try:
            descriptor = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return []
        except OSError as error:
            raise RepositoryError("registry_unavailable", "Repository registry cannot be read", 503) from error
        try:
            with os.fdopen(descriptor, "rb") as source:
                metadata = os.fstat(source.fileno())
                if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_BYTES:
                    raise ValueError("Invalid registry file")
                payload = source.read(MAX_BYTES + 1)
                if len(payload) > MAX_BYTES:
                    raise ValueError("Registry too large")
            document = Document.model_validate_json(payload)
            ids = [item.repository.id for item in document.repositories]
            roots = [item.repository.root for item in document.repositories]
            if len(set(ids)) != len(ids) or len(set(roots)) != len(roots):
                raise ValueError("Duplicate registration")
            if any(item.trust and item.trust.repository_id != item.repository.id for item in document.repositories):
                raise ValueError("Mismatched trust registration")
            return document.repositories
        except (OSError, ValueError, ValidationError) as error:
            raise RepositoryError("registry_unavailable", "Repository registry is invalid or unreadable", 503) from error

    def save(self, entries, configurations, trusts=None):
        payload = json.dumps({"schema_version": 1, "repositories": [
            {"repository": entry, "configuration": configurations.get(entry["id"]),
             "trust": (trusts or {}).get(entry["id"])}
            for entry in entries.values()
        ]}, ensure_ascii=True, indent=2).encode()
        if len(payload) > MAX_BYTES:
            raise RepositoryError("registry_unavailable", "Repository registry exceeds its size limit", 503)
        temporary = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if self.path.is_symlink():
                raise OSError("Unsafe registry file")
            descriptor, temporary = tempfile.mkstemp(prefix=".repositories-", dir=self.path.parent)
            with os.fdopen(descriptor, "wb") as target:
                target.write(payload)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, self.path)
        except OSError as error:
            raise RepositoryError("registry_unavailable", "Repository registry cannot be saved", 503) from error
        finally:
            if temporary is not None:
                Path(temporary).unlink(missing_ok=True)
