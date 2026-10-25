"""Static preflight and fixed profile for the first imported project adapter."""

import ast
from importlib import machinery, metadata, util
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys

from engine.adapters.base import Preflight, ProjectProfile
from engine.project_analysis import inspect_project
from engine.repositories.models import AdapterConfig


IMMUTABLE = ("requirements*.txt", "pyproject.toml", "setup.cfg", "setup.py", "Pipfile*")
MODULE_NAMES = {"python-multipart": "multipart", "pyyaml": "yaml", "pillow": "PIL"}


def _diagnostic(code, message, path=None):
    return dict(code=code, severity="error", message=message, path=path)


def _relative(value):
    path = PurePosixPath(value)
    return bool(value) and not path.is_absolute() and ".." not in path.parts and "\\" not in value and "\x00" not in value


def _inventory(code):
    files = []
    for directory, directories, names in os.walk(code, followlinks=False):
        for name in directories + names:
            path = Path(directory) / name
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise ValueError("Project must contain only regular files and directories")
            if stat.S_ISREG(mode):
                if path.stat().st_nlink != 1:
                    raise ValueError("Project files must not have external hard links")
                files.append(path.relative_to(code).as_posix())
                if len(files) > 4096:
                    raise ValueError("Project exceeds the static preflight file limit")
    return sorted(files)


def _declarations(path):
    if path.stat().st_size > 256 * 1024:
        raise ValueError("Dependency manifest exceeds the static preflight limit")
    text = path.read_text(encoding="utf-8")
    if re.fullmatch(r"requirements.*\.txt", path.name):
        return [re.split(r"\s+#", line.strip(), maxsplit=1)[0]
                for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")], None
    if path.name != "pyproject.toml":
        raise ValueError("Only requirements files and static PEP 621 dependencies are supported")
    section = ""
    dependencies = None
    python_requires = None
    lines = iter(text.splitlines())
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("["):
            section = stripped
        if section != "[project]" or not stripped or stripped.startswith("#"):
            continue
        if re.match(r"dynamic\s*=", stripped):
            raise ValueError("Dynamic project metadata is unsupported")
        if re.match(r"requires-python\s*=", stripped):
            if python_requires is not None:
                raise ValueError("Duplicate Python requirement")
            python_requires = ast.literal_eval(stripped.split("=", 1)[1].strip())
        if re.match(r"dependencies\s*=", stripped):
            if dependencies is not None:
                raise ValueError("Duplicate dependency declarations")
            value = stripped.split("=", 1)[1].strip()
            while True:
                try:
                    dependencies = ast.literal_eval(value)
                    break
                except (SyntaxError, ValueError):
                    value += "\n" + next(lines)
            if not isinstance(dependencies, list) or not all(isinstance(item, str) for item in dependencies):
                raise ValueError("Dependencies must be a static list of strings")
    if dependencies is None:
        raise ValueError("A static project dependencies list is required")
    return dependencies, python_requires


class FastAPISQLiteAdapter:
    id = "fastapi-sqlite-v1"

    def profile(self, configuration):
        config = AdapterConfig.model_validate(dict(configuration))
        if config.working_dir != "." or not _relative(config.tests) or config.tests == ".":
            raise ValueError("Only root-working-directory projects with a relative tests directory are supported")
        if (not config.health_path.startswith("/") or config.health_path.startswith("//")
                or any(character in config.health_path for character in ("?", "#", "\\", "\x00", "\r", "\n"))):
            raise ValueError("Health endpoint must be a local absolute HTTP path")
        return ProjectProfile(
            adapter=self.id, app=config.app,
            compile_paths=(config.app.split(".", 1)[0] if "." in config.app.split(":")[0]
                           else config.app.split(":")[0] + ".py",),
            tests=config.tests, health_path=config.health_path, smoke_paths=(config.health_path,),
            state_env=config.state_env, editable_prefixes=("",), immutable_paths=IMMUTABLE,
            protected_tests_prefix=config.tests.rstrip("/") + "/",
            sqlite_state_globs=("**/*.sqlite3", "**/*.sqlite", "**/*.db"),
            execution="sandboxed", providers=("scripted",),
        )

    def preflight(self, code, profile):
        diagnostics = []
        try:
            code = Path(code)
            if code.is_symlink():
                raise ValueError("Project code must not be a symlink")
            code = code.resolve(strict=True)
            expected = self.profile(dict(adapter=self.id, app=profile.app, tests=profile.tests,
                                         health_path=profile.health_path, state_env=profile.state_env))
            if expected != profile:
                raise ValueError("Project profile does not match this adapter")
            if any(code == Path(entry or os.curdir).resolve() or code in Path(entry or os.curdir).resolve().parents
                   for entry in sys.path):
                raise ValueError("Engine import path must not contain project code")
            files = _inventory(code)
            analysis = inspect_project(code, files)
            if analysis["status"] != "supported":
                diagnostics.append(_diagnostic("project_unsupported", "Committed copy does not match the supported static project type"))
            candidates = analysis["candidates"]
            if (not any(item["target"] == profile.app for item in candidates["app"])
                    or not any(item["path"] == profile.tests for item in candidates["tests"])
                    or not any(item["path"] == profile.health_path for item in candidates["health"])):
                diagnostics.append(_diagnostic("profile_mismatch", "Committed layout does not match the validated configuration"))
            from packaging.requirements import Requirement
            from packaging.specifiers import SpecifierSet
            for manifest in analysis["dependencies"]:
                relative = manifest["path"]
                try:
                    declarations, python_requires = _declarations(code / relative)
                    if len(declarations) > 1000:
                        raise ValueError("Too many dependency declarations")
                    if python_requires is not None and not SpecifierSet(python_requires).contains(
                            ".".join(str(part) for part in sys.version_info[:3])):
                        diagnostics.append(_diagnostic("python_unavailable", "Engine Python does not satisfy the project requirement", relative))
                    for declaration in declarations:
                        requirement = Requirement(declaration)
                        if requirement.url or requirement.extras:
                            raise ValueError("URL and extra dependencies are unsupported")
                        if requirement.marker and not requirement.marker.evaluate():
                            continue
                        name = re.sub(r"[-_.]+", "-", requirement.name).lower()
                        module = MODULE_NAMES.get(name, name.replace("-", "_"))
                        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", module):
                            raise ValueError("Dependency module name is unsupported")
                        if ((code / module).exists()
                                or any((code / (module + suffix)).exists() for suffix in machinery.all_suffixes())):
                            diagnostics.append(_diagnostic("dependency_shadowed", "Project shadows installed dependency " + name, relative))
                            continue
                        if util.find_spec(module) is None:
                            diagnostics.append(_diagnostic("dependency_unavailable", "Engine dependency unavailable: " + name, relative))
                            continue
                        try:
                            version = metadata.version(requirement.name)
                        except metadata.PackageNotFoundError:
                            diagnostics.append(_diagnostic("dependency_unavailable", "Engine dependency metadata unavailable: " + name, relative))
                            continue
                        if requirement.specifier and not requirement.specifier.contains(version):
                            diagnostics.append(_diagnostic("dependency_unavailable", "Engine dependency version incompatible: " + name, relative))
                except (ValueError, SyntaxError, StopIteration, TypeError, RecursionError):
                    diagnostics.append(_diagnostic("dependency_unsupported", "Dependency manifest requires unsupported configuration", relative))
        except (OSError, ValueError, ImportError):
            diagnostics.append(_diagnostic("preflight_unsupported", "Cannot safely verify the project layout or engine dependencies"))
        return Preflight(ok=not diagnostics, diagnostics=diagnostics)

    def initialize_state(self, state):
        state = Path(state)
        if any(path.is_symlink() for path in (state, *state.parents)):
            raise ValueError("State directory must not be a symlink")
        state.mkdir(parents=True, exist_ok=True)
        if not state.is_dir() or any(state.iterdir()):
            raise ValueError("Initial project state must be an empty directory")


ADAPTER = FastAPISQLiteAdapter()
