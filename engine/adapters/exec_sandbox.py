"""Fail-closed execution boundary for copied, explicitly trusted projects."""

from functools import lru_cache
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from typing import Dict, List, Mapping, Optional, Sequence

from engine.jobs import scrubbed_environment


def _sites() -> List[Path]:
    return sorted({
        Path(entry).resolve() for entry in sys.path
        if entry and Path(entry).name == "site-packages" and Path(entry).is_dir()
    })


def environment(base: Mapping[str, str], run_tmp: Path) -> Dict[str, str]:
    run_tmp = Path(run_tmp).resolve(strict=True)
    if not run_tmp.is_dir():
        raise ValueError("Sandbox temporary path must be a directory")
    result = scrubbed_environment()
    if "PARADOX_APP_DIR" in base:
        result["PARADOX_APP_DIR"] = base["PARADOX_APP_DIR"]
    result.update(
        HOME=str(run_tmp), TMPDIR=str(run_tmp),
        PYTHONPYCACHEPREFIX=str(run_tmp / "pycache"),
        PYTHONPATH=os.pathsep.join([*(str(path) for path in _sites()), "."]),
        PYTHONDONTWRITEBYTECODE="1", PYTEST_DISABLE_PLUGIN_AUTOLOAD="1",
    )
    return result


def _filter(kind: str, path: Path) -> str:
    return "(%s %s)" % (kind, json.dumps(str(path), ensure_ascii=False))


@lru_cache(maxsize=1)
def _interpreter_aliases() -> tuple:
    current = Path(sys.executable).absolute()
    expected = current.resolve(strict=True)
    aliases = []
    for _ in range(8):
        if current.resolve(strict=True) != expected:
            raise ValueError("Engine interpreter aliases changed during initialization")
        aliases.append(current)
        if not current.is_symlink():
            return tuple(aliases)
        target = Path(os.readlink(current))
        current = Path(os.path.normpath(str(target if target.is_absolute() else current.parent / target)))
    raise ValueError("Engine interpreter has an unsupported symlink chain")


def _command(argv: Sequence[str], writable: Sequence[Path], run_root: Path) -> List[str]:
    root = Path(run_root).resolve(strict=True)
    if not root.is_dir() or root == Path(root.anchor) or root == Path.home():
        raise ValueError("Sandbox requires a private run directory")
    interpreter = Path(sys.executable).resolve(strict=True)
    if not argv or Path(argv[0]).resolve() != interpreter:
        raise ValueError("Sandbox commands must use the engine Python interpreter")
    write_filters = []
    for entry in writable:
        original = Path(entry).absolute()
        resolved = original.resolve(strict=True)
        if original != resolved or root not in resolved.parents:
            raise ValueError("Writable paths must be non-symlink children of the run directory")
        metadata = resolved.stat()
        if stat.S_ISDIR(metadata.st_mode):
            write_filters.append(_filter("subpath", resolved))
        elif stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1:
            write_filters.append(_filter("literal", resolved))
        else:
            raise ValueError("Writable paths must be private regular files or directories")
    prefix = Path(sys.base_prefix).resolve()
    framework = prefix / "Resources/Python.app/Contents/MacOS/Python"
    aliases = _interpreter_aliases()
    literal_reads = [*aliases, Path(sys.prefix).absolute() / "pyvenv.cfg"]
    readable = [root, prefix, *_sites(), Path("/System"), Path("/usr/lib"), Path("/usr/share")]
    read_filters = " ".join(_filter("subpath", path) for path in readable)
    ancestors = sorted({parent for path in [*readable, *literal_reads] for parent in path.parents})
    home = Path.home().resolve()
    profile = "\n".join([
        "(version 1)", "(allow default)",
        "(deny file-read*)", "(deny file-write*)", "(deny process-exec)",
        "(deny network*)",
        "(deny mach-lookup)", "(deny user-preference-read)",
        "(deny process-info*)", "(allow process-info* (target self))",
        "(deny sysctl-read)",
        '(allow sysctl-read (sysctl-name "kern.ostype") (sysctl-name "kern.hostname") (sysctl-name "kern.osrelease") (sysctl-name "kern.version") (sysctl-name "hw.machine") (sysctl-name "hw.ncpu"))',
        "(deny signal)", "(allow signal (target same-sandbox))",
        "(allow network-bind (local ip \"localhost:*\"))",
        "(allow network-inbound (local ip \"localhost:*\"))",
        "(allow network-outbound (remote ip \"localhost:*\"))",
        "(deny file-read* %s)" % _filter("subpath", home),
        "(allow file-read* %s %s)" % (_filter("literal", home), read_filters),
        "(allow file-read* %s)" % " ".join(_filter("literal", path) for path in literal_reads),
        "(allow file-read-metadata %s)" % " ".join(_filter("literal", path) for path in ancestors),
        '(allow file-read* (literal "/") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/dtracehelper"))',
        "(allow process-exec %s)" % " ".join(_filter("literal", path) for path in [*aliases, interpreter, framework]),
        '(allow file-write* (literal "/dev/null"))',
        "(allow file-write* %s)" % " ".join(write_filters) if write_filters else "",
    ])
    return ["/usr/bin/sandbox-exec", "-p", profile, str(aliases[0]), *argv[1:]]


@lru_cache(maxsize=1)
def availability_reason() -> Optional[str]:
    if sys.platform != "darwin" or not os.access("/usr/bin/sandbox-exec", os.X_OK):
        return "macOS execution sandbox is unavailable"
    try:
        with tempfile.TemporaryDirectory(prefix="paradox-sandbox-probe-") as directory:
            parent = Path(directory).resolve()
            root = parent / "run"
            root.mkdir()
            writable = root / "tmp"
            writable.mkdir()
            secret = parent / "outside"
            secret.write_text("probe")
            probe = (
                "import errno,os,pathlib,socket,subprocess; "
                "root=pathlib.Path(%r); secret=pathlib.Path(%r); "
                "(root/'tmp'/'allowed').write_text('ok'); "
                "exec(%r)"
            ) % (str(root), str(secret),
                "for operation in [lambda: secret.read_text(), lambda: secret.write_text('no'), "
                "lambda: subprocess.run(['/bin/sh','-c','true']), "
                "lambda: socket.create_connection(('1.1.1.1',80),timeout=1)]:\n"
                " try:\n  operation()\n except PermissionError:\n  pass\n"
                " else:\n  raise AssertionError('sandbox restriction not enforced')\n"
                "listener=socket.socket(); listener.bind(('127.0.0.1',0)); listener.listen(); "
                "client=socket.create_connection(listener.getsockname(),timeout=1); "
                "connection,address=listener.accept(); connection.close(); client.close(); listener.close()")
            probe += (
                "; import ctypes; library=ctypes.CDLL(None,use_errno=True); "
                "mib=(ctypes.c_int*3)(1,49,%d); size=ctypes.c_size_t(262144); "
                "buffer=ctypes.create_string_buffer(size.value); "
                "assert library.sysctl(mib,3,buffer,ctypes.byref(size),None,0)==-1 "
                "and ctypes.get_errno() in (1,13)"
            ) % os.getpid()
            probe += (
                "; bootstrap=ctypes.c_uint.in_dll(library,'bootstrap_port'); "
                "service=ctypes.c_uint(); "
                "assert library.bootstrap_look_up(bootstrap,b'com.apple.pasteboard.1',ctypes.byref(service))==1100"
            )
            result = subprocess.run(
                _command([sys.executable, "-c", probe], [writable], root),
                cwd=root, env=environment({}, writable), stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
            )
            if result.returncode:
                return "Execution sandbox enforcement probe failed"
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        return "Execution sandbox could not initialize"
    return None


def wrap(argv: Sequence[str], writable: Sequence[Path], run_root: Path) -> List[str]:
    reason = availability_reason()
    if reason:
        raise RuntimeError(reason)
    return _command(argv, writable, run_root)
