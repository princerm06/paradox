from pathlib import Path
import runpy
import subprocess

import pytest

from engine.projects.importer import import_head
from engine.repositories.git import RepositoryError
from engine.repositories.inspection import validate
from engine.repositories.registry import Registry


def git(root, *arguments):
    return subprocess.run(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-C", str(root), *arguments],
                          env={"PATH": "/usr/bin:/bin", "HOME": str(root)}, check=True, capture_output=True)


def commit(root):
    git(root, "add", ".")
    git(root, "-c", "user.name=Disposable", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture")


def identity(root):
    return {str(path.relative_to(root)): (path.read_bytes(), path.stat().st_mtime_ns)
            for path in root.rglob("*") if path.is_file() and not path.is_symlink()}


@pytest.fixture
def source(tmp_path):
    builder = runpy.run_path(str(Path(__file__).parent / "fixtures/projects/build.py"))
    root = builder["build_notes_repo"](tmp_path)
    registry = Registry([], tmp_path / "engine")
    rid = registry.register(str(root))["id"]
    assert validate(registry, rid, None)["valid"]
    return root, registry, rid


def test_readonly_committed_import_ignores_dirty_files_and_filters(source, tmp_path):
    root, registry, rid = source
    marker = tmp_path / "forbidden-marker"
    script = tmp_path / "filter.sh"
    script.write_text("#!/bin/sh\ntouch " + str(marker) + "\ncat\n")
    script.chmod(0o700)
    (root / ".gitattributes").write_text("*.py filter=hostile\n")
    commit(root)
    git(root, "config", "filter.hostile.smudge", str(script))
    git(root, "config", "core.fsmonitor", str(script))
    (root / "notes_app/ranking.py").write_text("raise RuntimeError('dirty-only')\n")
    (root / "untracked.sqlite3").write_bytes(b"source database must stay untouched")
    before = identity(root)
    base, profile = import_head(registry, rid, tmp_path / "import/code")
    assert base["dirty"]
    assert "chronological" in (tmp_path / "import/code/notes_app/ranking.py").read_text()
    assert not (tmp_path / "import/code/untracked.sqlite3").exists()
    assert profile.execution == "sandboxed"
    assert not marker.exists()
    assert identity(root) == before


@pytest.mark.parametrize("layout", ["symlink", "submodule", "oversize"])
def test_rejects_unsafe_committed_layout(source, tmp_path, layout):
    root, registry, rid = source
    if layout == "symlink":
        (root / "escape").symlink_to(tmp_path)
        commit(root)
    elif layout == "submodule":
        head = git(root, "rev-parse", "HEAD").stdout.decode().strip()
        git(root, "update-index", "--add", "--cacheinfo", "160000," + head + ",foreign")
        git(root, "-c", "user.name=Disposable", "-c", "user.email=fixture@example.invalid", "commit", "-m", "submodule")
    else:
        (root / "large.dat").write_bytes(b"x" * (1024 * 1024 + 1))
        commit(root)
    before = identity(root)
    with pytest.raises(RepositoryError) as error:
        import_head(registry, rid, tmp_path / "import/code")
    assert error.value.code == "import_rejected"
    assert identity(root) == before


def test_dirty_analysis_cannot_authorize_invalid_committed_copy(source, tmp_path):
    root, registry, rid = source
    main = root / "notes_app/main.py"
    original = main.read_text()
    main.write_text("not valid Python :\n")
    commit(root)
    main.write_text(original)
    assert validate(registry, rid, None)["valid"]
    before = identity(root)
    with pytest.raises(RepositoryError) as error:
        import_head(registry, rid, tmp_path / "import/code")
    assert error.value.code == "validation_required"
    assert identity(root) == before


@pytest.mark.parametrize("path", [b"../outside.py", b"/absolute.py", b".git/config", b"pkg/../../x", b"pkg/\\x", b"pkg/\xff.py"])
def test_tree_path_rejections_before_blob_read(source, tmp_path, monkeypatch, path):
    root, registry, rid = source
    calls = []
    def tree_only(root, *arguments, **keywords):
        calls.append(arguments[0])
        return b"100644 blob " + b"a" * 40 + b" 0\t" + path + b"\0"
    monkeypatch.setattr(registry.git, "run_bytes", tree_only)
    monkeypatch.setattr(registry.git, "inspect", lambda root: ({"head": "a" * 40, "branch": "main", "dirty": False}, []))
    with pytest.raises(RepositoryError, match="Unsupported committed"):
        import_head(registry, rid, tmp_path / "import/code")
    assert calls == ["ls-tree"]


def test_blob_batch_is_binary_and_does_not_deadlock(source, tmp_path):
    root, registry, rid = source
    payload = bytes(range(256)) * 4096
    (root / "data.bin").write_bytes(payload)
    commit(root)
    import_head(registry, rid, tmp_path / "import/code")
    assert (tmp_path / "import/code/data.bin").read_bytes() == payload
