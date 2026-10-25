"""Write confinement for the trusted imported-project agent, never application execution."""

import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import shutil
import subprocess
import sys
import tempfile
import uuid

from engine.jobs import scrubbed_environment


EXECUTABLE = Path("/usr/bin/sandbox-exec")
MARKER = "macos-project-write-v1"
AUTOLOAD = frozenset({".factory", ".claude", ".agents", ".codex", ".mcp.json"})
FORBIDDEN = AUTOLOAD | {".git", "node_modules"}
CONTROL = frozenset({"agents.md", "conftest.py", "pytest.ini", ".pytest.ini", "tox.ini", "setup.cfg",
                     "pyproject.toml", "sitecustomize.py", "usercustomize.py"})
MAX_PATHS = 4096
MAX_BYTES = 16 * 1024 * 1024
MAX_ANCESTORS = 64


def _root(code):
    original = Path(code).absolute()
    resolved = original.resolve(strict=True)
    if original != resolved or not resolved.is_dir():
        raise ValueError("Agent code must be a real non-symlink directory")
    if resolved in (Path(resolved.anchor), Path.home().resolve()):
        raise ValueError("Agent requires a private isolated future")
    return resolved


def _relative(value):
    path = PurePosixPath(value)
    return bool(value) and not path.is_absolute() and not any(
        part in ("", ".", "..") for part in value.split("/")) and "\\" not in value and "\x00" not in value


def protected_files(code, profile):
    code = _root(code)
    ancestors = code.parents
    if len(ancestors) > MAX_ANCESTORS:
        raise ValueError("Agent path exceeds the ancestor configuration check limit")
    for ancestor in ancestors:
        for name in sorted(AUTOLOAD):
            try:
                (ancestor / name).lstat()
            except FileNotFoundError:
                continue
            raise ValueError("Agent ancestor configuration is unsupported; use an isolated state path with clean ancestors")
    if profile.adapter != "fastapi-sqlite-v1" or profile.execution != "sandboxed":
        raise ValueError("Imported agent requires the sandboxed FastAPI/SQLite adapter")
    if not profile.protected_tests_prefix.endswith("/") or not _relative(profile.protected_tests_prefix[:-1]):
        raise ValueError("Invalid protected test prefix")
    if not profile.editable_prefixes or any(prefix and not _relative(prefix.rstrip("/"))
                                            for prefix in profile.editable_prefixes):
        raise ValueError("Invalid editable prefixes")
    protected = []
    count = 0
    total = 0
    for directory, directories, names in os.walk(code, followlinks=False):
        for name in sorted(directories + names):
            path = Path(directory) / name
            relative = path.relative_to(code).as_posix()
            count += 1
            if count > MAX_PATHS or len(relative.encode("utf-8")) > 4096 or not _relative(relative):
                raise ValueError("Agent inventory exceeds supported path limits")
            metadata = path.lstat()
            if name.lower() in FORBIDDEN:
                raise ValueError("Agent configuration/control paths are unsupported")
            if stat.S_ISDIR(metadata.st_mode):
                continue
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                raise ValueError("Agent inventory requires private regular files without links")
            total += metadata.st_size
            if metadata.st_size > 256 * 1024 or total > MAX_BYTES:
                raise ValueError("Agent inventory exceeds supported byte limits")
            if (relative.startswith(profile.protected_tests_prefix)
                    or any(fnmatch.fnmatchcase(relative if "/" in pattern else name, pattern)
                           for pattern in profile.immutable_paths)
                    or name.lower() in CONTROL or name.lower().endswith(".pth")
                    or not any(relative.startswith(prefix) for prefix in profile.editable_prefixes)):
                protected.append(relative)
    return tuple(sorted(protected))


def _filter(kind, path):
    return "(%s %s)" % (kind, json.dumps(str(path), ensure_ascii=False))


def _operations(code):
    parent = Path(tempfile.gettempdir()).resolve() / ("paradox-imported-agents-" + str(os.getuid()))
    return parent / hashlib.sha256(str(code).encode("utf-8")).hexdigest()


def _private_directory(path, create=True):
    if create:
        path.mkdir(mode=0o700, exist_ok=True)
    metadata = path.lstat()
    if (not stat.S_ISDIR(metadata.st_mode) or path.resolve() != path.absolute()
            or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o700):
        raise ValueError("Agent operational directories must be private non-symlink owned directories")


def cleanup(code):
    operations = _operations(_root(code))
    if not operations.parent.exists() and not operations.parent.is_symlink():
        return
    _private_directory(operations.parent, create=False)
    if not operations.exists() and not operations.is_symlink():
        return
    _private_directory(operations, create=False)
    shutil.rmtree(operations)


def _prefix(code, scratch, factory, protected):
    immutable = {code / relative for relative in protected}
    ancestors = {parent for path in immutable for parent in path.parents if parent == code or code in parent.parents}
    forbidden = "|".join("".join("[%s%s]" % (character.lower(), character.upper())
                                if character.isalpha() else "[.]" if character == "." else character
                                for character in name) for name in sorted(FORBIDDEN | CONTROL))
    rules = ["(version 1)", "(allow default)", "(deny file-write*)",
             "(allow file-write* %s %s %s (literal \"/dev/null\"))" % (
                 _filter("subpath", code), _filter("subpath", scratch), _filter("subpath", factory)),
             '(deny file-write* (require-all %s (regex #"(^|/)(%s)(/|$)")))' % (
                 _filter("subpath", code), forbidden),
             '(deny file-write* (require-all %s (regex #"[.][pP][tT][hH]$")))' % _filter("subpath", code)]
    if immutable:
        rules.append("(deny file-write* %s)" % " ".join(
            _filter("literal", path) for path in sorted(immutable | ancestors)))
    return [str(EXECUTABLE), "-p", "\n".join(rules)]


def availability_reason():
    if sys.platform != "darwin" or not os.access(EXECUTABLE, os.X_OK):
        return "Imported Droid requires the macOS write sandbox; no unsandboxed fallback is permitted"
    try:
        with tempfile.TemporaryDirectory(prefix="paradox-imported-agent-") as directory:
            root = Path(directory).resolve()
            code = root / "code"
            scratch = root / "tmp"
            factory = root / "factory"
            for path in (code, scratch, factory):
                path.mkdir()
            protected = code / "protected"
            protected.write_text("frozen")
            _probe(_prefix(code, scratch, factory, ("protected",)), code, scratch, protected, root / "outside")
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        return "Imported Droid write sandbox failed its offline enforcement check"
    return None


def _probe(prefix, code, scratch, protected, outside):
    identifier = uuid.uuid4().hex
    writable = code / (".sandbox-allowed-" + identifier)
    temporary = scratch / ("probe-" + identifier)
    script = (
        "import os,pathlib,sys\n"
        "allowed,tmp,protected,outside=map(pathlib.Path,sys.argv[1:])\n"
        "allowed.write_text('allowed');tmp.write_text('scratch')\n"
        "for target in (protected,outside):\n"
        " try: target.write_text('denied')\n"
        " except PermissionError: pass\n"
        " else: raise SystemExit(10)\n"
        "try: protected.unlink()\n"
        "except PermissionError: pass\n"
        "else: raise SystemExit(11)\n"
    )
    try:
        result = subprocess.run(prefix + [sys.executable, "-I", "-B", "-c", script,
                                         str(writable), str(temporary), str(protected), str(outside)],
                                env={"PATH": os.defpath}, capture_output=True, timeout=5)
        if result.returncode or not writable.is_file() or not temporary.is_file() or outside.exists():
            raise RuntimeError("Imported Droid write sandbox enforcement failed")
    finally:
        writable.unlink(missing_ok=True)
        temporary.unlink(missing_ok=True)


def prepare(code, command, environment, profile):
    if sys.platform != "darwin" or not os.access(EXECUTABLE, os.X_OK):
        raise RuntimeError("Imported Droid requires the macOS write sandbox; no unsandboxed fallback is permitted")
    code = _root(code)
    protected = protected_files(code, profile)
    if not command or not Path(command[0]).is_absolute():
        raise ValueError("Agent executable must be an absolute trusted command")
    operations = _operations(code)
    home = operations / "home"
    factory = home / ".factory"
    scratch = operations / "tmp"
    _private_directory(operations.parent)
    operations.mkdir(mode=0o700, exist_ok=False)
    for path in (operations, home, factory, scratch):
        _private_directory(path)
    prefix = _prefix(code, scratch, factory, protected)
    sentinel = scratch / ("protected-" + uuid.uuid4().hex)
    sentinel.write_text("frozen")
    try:
        probe_prefix = _prefix(code, scratch, factory, protected)
        if not protected:
            probe_prefix[2] += "\n(deny file-write* %s)" % _filter("literal", sentinel)
        _probe(probe_prefix, code, scratch, code / protected[0] if protected else sentinel,
               operations / ("denied-" + uuid.uuid4().hex))
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError("Imported Droid sandbox could not initialize") from error
    finally:
        sentinel.unlink(missing_ok=True)
    result = scrubbed_environment()
    for name in ("FACTORY_API_KEY", "PARADOX_DROID_MODEL"):
        if name in environment:
            result[name] = environment[name]
    result.update(HOME=str(home), TMPDIR=str(scratch), PARADOX_DROID_SANDBOX=MARKER)
    return prefix + list(command), result
