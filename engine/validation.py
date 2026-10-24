import difflib
from pathlib import Path
import time
import xml.etree.ElementTree as ET

import httpx

from engine.jobs import log_line, scrubbed_environment
from engine.runtime import Runtime
from engine.storage import copy_tree


def files(root):
    result = {}
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("Symlinks are not allowed")
        if "__pycache__" in path.parts or path.suffix == ".pyc":
            continue
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError("Special files are not allowed")
        if path.stat().st_size > 256 * 1024:
            raise ValueError("Files must not exceed 256 KB")
        result[path.relative_to(root).as_posix()] = path.read_bytes()
    return result


def changes(base, current):
    records = []
    patches = []
    for path in sorted(set(base) | set(current)):
        if base.get(path) == current.get(path):
            continue
        before = base.get(path, b"").decode("utf-8", errors="replace").splitlines(keepends=True)
        after = current.get(path, b"").decode("utf-8", errors="replace").splitlines(keepends=True)
        patch = list(difflib.unified_diff(before, after, fromfile="a/" + path if path in base else "/dev/null", tofile="b/" + path if path in current else "/dev/null"))
        records.append({"path": path, "status": "added" if path not in base else "deleted" if path not in current else "modified", "additions": sum(line.startswith("+") and not line.startswith("+++") for line in patch), "deletions": sum(line.startswith("-") and not line.startswith("---") for line in patch)})
        patches.extend(patch)
    return {"files": records}, "".join(patches)


def guard(base, current, changed):
    paths = [item["path"] for item in changed["files"]]
    if not paths:
        raise ValueError("Agent made no code changes")
    if len(paths) > 50:
        raise ValueError("At most 50 changed files are allowed")
    for path in paths:
        if not path.startswith("demo_app/"):
            raise ValueError("Changes outside demo_app/ are not allowed")
        if path == "demo_app/AGENTS.md":
            raise ValueError("demo_app/AGENTS.md is immutable")
        if path.startswith("demo_app/tests/") and path in base:
            raise ValueError("Existing demo_app/tests files are immutable")


def test_counts(report):
    if not report.exists():
        return {"passed": 0, "failed": 0, "errors": 0}
    root = ET.parse(report).getroot()
    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    failed = sum(int(suite.get("failures", 0)) for suite in suites)
    errors = sum(int(suite.get("errors", 0)) for suite in suites)
    total = sum(int(suite.get("tests", 0)) for suite in suites)
    skipped = sum(int(suite.get("skipped", 0)) for suite in suites)
    return {"passed": max(0, total - failed - errors - skipped), "failed": failed, "errors": errors}


def validate_runtime(directory, code, base_state, control, log, record_check):
    root = directory / "validation-runtime"
    root.mkdir()
    (root / "workspace").mkdir()
    copy_tree(code, root / "workspace" / "code")
    copy_tree(base_state, root / "workspace" / "state")
    runtime = Runtime(root, port=0, environment=scrubbed_environment(), control=control)
    started = time.monotonic()
    try:
        runtime.start()
        boot_ms = round((time.monotonic() - started) * 1000)
        record_check("boot", started, None)
        started = time.monotonic()
        control.check()
        with httpx.Client(timeout=5, trust_env=False) as client:
            for path in ("/health", "/api/posts"):
                response = client.get(runtime.url + path)
                if response.status_code != 200:
                    raise RuntimeError(f"GET {path} returned {response.status_code}")
                log_line(log, f"GET {path} 200")
        record_check("smoke", started, "GET /health 200, GET /api/posts 200")
        return boot_ms
    finally:
        runtime.stop()
