import difflib
import io
import json
import os
from pathlib import Path
import stat
import sys
import time
import tokenize
from uuid import uuid4
import xml.etree.ElementTree as ET

import httpx

from engine.jobs import log_line, scrubbed_environment
from engine.runtime import Runtime
from engine.storage import copy_tree


TEST_BOOTSTRAP = """
import importlib.util
import json
from pathlib import Path
import sys
import pytest

fixture = Path(sys.argv[1])
plugins = []
if fixture.is_file():
    spec = importlib.util.spec_from_file_location('paradox_baseline_fixtures', fixture)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    plugins.append(module)
if sys.argv[2] != '-':
    class BaselineCollection:
        def pytest_collection_finish(self, session):
            Path(sys.argv[2]).write_text(json.dumps(len(session.items)))
    plugins.append(BaselineCollection())
raise SystemExit(pytest.main(sys.argv[3:], plugins=plugins))
"""


def reject_bytecode(root):
    for path in root.rglob("*"):
        if path.name.lower() == "__pycache__" or path.suffix.lower() == ".pyc":
            raise ValueError("Agent-supplied bytecode/cache artifacts are not allowed: " + path.relative_to(root).as_posix())


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
        name = Path(path).name.lower()
        if name in {"conftest.py", "pytest.ini", ".pytest.ini", "tox.ini", "setup.cfg", "pyproject.toml", "sitecustomize.py", "usercustomize.py"} or name.endswith(".pth"):
            raise ValueError("Validation configuration/hooks are protected: " + path)
        if path.endswith(".py") and path in current:
            try:
                tokens = tokenize.tokenize(io.BytesIO(current[path]).readline)
                if any(token.type == tokenize.NAME and token.string == "pytest_plugins" for token in tokens):
                    raise ValueError("pytest_plugins declarations are not allowed: " + path)
            except (tokenize.TokenError, IndentationError, SyntaxError):
                pass
        if not path.startswith("demo_app/"):
            raise ValueError("Changes outside demo_app/ are not allowed")
        if path == "demo_app/AGENTS.md":
            raise ValueError("demo_app/AGENTS.md is immutable")
        if path.startswith("demo_app/tests/") and path in base:
            raise ValueError("Existing demo_app/tests files are immutable")


def require_regular_report(report):
    try:
        regular = stat.S_ISREG(report.lstat().st_mode)
    except OSError as error:
        raise ValueError("Test report missing or unreadable: " + report.name) from error
    if not regular:
        raise ValueError("Test report must be a regular file, not a symlink: " + report.name)


def baseline_test_count(directory, base, control, log):
    code = directory / "baseline-collection"
    copy_tree(base / "code", code)
    report = directory / f"collection-{uuid4().hex}.json"
    environment = scrubbed_environment()
    environment["PARADOX_APP_DIR"] = str(directory / "baseline-test-state")
    result = control.run([
        sys.executable, "-c", TEST_BOOTSTRAP, str(base / "code/demo_app/tests/conftest.py"),
        str(report), "--collect-only", "-q", "--noconftest", "-p", "no:cacheprovider",
        "-c", os.devnull, "--rootdir", str(code), "demo_app/tests",
    ], code, log, 120, environment=environment)
    if result:
        raise ValueError("Immutable baseline test collection failed; inspect validation logs")
    require_regular_report(report)
    try:
        count = json.loads(report.read_text())
    except (OSError, ValueError) as error:
        raise ValueError("Immutable baseline test collection report is invalid") from error
    if type(count) is not int or count < 1:
        raise ValueError("Immutable baseline must collect at least one test")
    log_line(log, f"Immutable baseline collected {count} tests")
    return count


def test_counts(report):
    require_regular_report(report)
    try:
        root = ET.parse(report).getroot()
        if root.tag not in {"testsuite", "testsuites"}:
            raise ValueError("Unexpected JUnit root element")
        suites = [suite for suite in root.iter("testsuite") if not suite.findall("testsuite")]
        totals = {name: sum(int(suite.get(name, 0)) for suite in suites)
                  for name in ("tests", "failures", "errors", "skipped")}
        cases = list(root.iter("testcase"))
        actual = {"tests": len(cases),
                  "failures": sum(case.find("failure") is not None for case in cases),
                  "errors": sum(case.find("error") is not None for case in cases),
                  "skipped": sum(case.find("skipped") is not None for case in cases)}
        if not suites or totals != actual or any(value < 0 for value in totals.values()):
            raise ValueError("JUnit counts do not match test cases")
        passed = totals["tests"] - totals["failures"] - totals["errors"] - totals["skipped"]
        if passed < 0:
            raise ValueError("JUnit counts are inconsistent")
    except (OSError, ET.ParseError, ValueError) as error:
        raise ValueError("Test report invalid: " + str(error)) from error
    return {"passed": passed, "failed": totals["failures"], "errors": totals["errors"]}


def require_test_success(result, counts, expected):
    executed = sum(counts.values())
    if result or counts["failed"] or counts["errors"]:
        raise ValueError("Generated application tests failed; inspect validation logs")
    if executed < expected:
        raise ValueError(f"Test report missing or incomplete: {executed} executed, expected at least {expected}")


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
