from pathlib import Path, PurePosixPath
import re
import unicodedata

from engine.adapters.fastapi_sqlite import ADAPTER
from engine.project_analysis import inspect_project
from engine.repositories.git import RepositoryError
from engine.repositories.inspection import validate_inspection
from engine.repositories.models import AdapterConfig


def import_head(registry, repository_id, destination):
    root = registry.checked_root(repository_id)
    status, unused = registry.git.inspect(root)
    commit = status["head"]
    if not commit or not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", commit):
        raise RepositoryError("import_rejected", "A committed HEAD is required")
    listing = registry.git.run_bytes(root, "ls-tree", "-r", "-l", "-z", "--full-tree", commit)
    entries = []
    seen = set()
    total = 0
    for record in filter(None, listing.split(b"\0")):
        try:
            header, raw_path = record.split(b"\t", 1)
            mode, kind, object_id, raw_size = header.split()
            relative = raw_path.decode("utf-8")
            path = PurePosixPath(relative)
            size = int(raw_size)
            collision = unicodedata.normalize("NFD", relative).casefold()
            if (mode not in (b"100644", b"100755") or kind != b"blob"
                    or not re.fullmatch(rb"[a-f0-9]{40}|[a-f0-9]{64}", object_id)
                    or not relative or path.is_absolute() or str(path) != relative
                    or any(part in (".", "..") or part.casefold() == ".git" for part in path.parts)
                    or "\\" in relative or "\x00" in relative or collision in seen
                    or size < 0 or size > 1024 * 1024):
                raise ValueError("Unsafe tree entry")
        except (ValueError, UnicodeDecodeError) as error:
            raise RepositoryError("import_rejected", "Unsupported committed path, object type or file size") from error
        total += size
        if len(entries) >= 10000 or total > 50 * 1024 * 1024:
            raise RepositoryError("import_rejected", "Committed tree exceeds import limits")
        seen.add(collision)
        entries.append((relative, object_id, size))
    destination = Path(destination)
    destination.mkdir(parents=True)
    payload = registry.git.run_bytes(root, "cat-file", "--batch",
                                     input_data=b"".join(object_id + b"\n" for unused, object_id, size in entries),
                                     output_limit=52 * 1024 * 1024)
    cursor = 0
    for relative, object_id, size in entries:
        expected = object_id + b" blob " + str(size).encode() + b"\n"
        if payload[cursor:cursor + len(expected)] != expected:
            raise RepositoryError("import_rejected", "Committed object stream is inconsistent")
        cursor += len(expected)
        content = payload[cursor:cursor + size]
        cursor += size
        if len(content) != size or payload[cursor:cursor + 1] != b"\n":
            raise RepositoryError("import_rejected", "Committed object stream is incomplete")
        cursor += 1
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as output:
            output.write(content)
    if cursor != len(payload):
        raise RepositoryError("import_rejected", "Unexpected committed object data")
    configuration = registry.configuration(repository_id)
    if not configuration:
        raise RepositoryError("validation_required", "Save a validated adapter configuration before importing")
    files = sorted(relative for relative, unused, size in entries)
    inspection = {"repository": {**registry.get(repository_id), "root": str(destination)},
                  "git": {"dirty": False}, "analysis": inspect_project(destination, files)}
    validation = validate_inspection(inspection, AdapterConfig.model_validate(configuration))
    if not validation["valid"]:
        raise RepositoryError("validation_required", "Committed project does not satisfy the saved adapter configuration")
    profile = ADAPTER.profile(configuration)
    preflight = ADAPTER.preflight(destination, profile)
    if not preflight.ok:
        raise RepositoryError("dependency_unavailable", "Committed project failed dependency or layout preflight")
    return {"commit": commit, "branch": status["branch"], "dirty": status["dirty"]}, profile
