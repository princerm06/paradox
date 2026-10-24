from pathlib import Path, PurePosixPath

from engine.repositories.models import AdapterConfig


def diagnostic(code, message, severity="error", path=None):
    return {"code": code, "severity": severity, "message": message, "path": path}


def analyze(root, files):
    try:
        from engine.project_analysis import inspect_project
    except ModuleNotFoundError as error:
        if error.name != "engine.project_analysis":
            raise
        return {"schema": "paradox.project-analysis/v1", "status": "unsupported", "adapter": None,
                "runtime": {"language": None, "framework": None, "python_requires": None}, "dependencies": [],
                "candidates": {"app": [], "tests": [], "health": [], "state": []},
                "diagnostics": [diagnostic("analysis_unavailable", "Project analysis module is not integrated")]}
    return inspect_project(root, files)


def inspect(registry, repository_id):
    repository = registry.get(repository_id)
    root = Path(repository["root"])
    git, tracked = registry.git.inspect(root)
    top = {}
    for relative in tracked:
        parts = PurePosixPath(relative).parts
        top[parts[0]] = "dir" if len(parts) > 1 else "file"
    return {"repository": repository, "git": git,
            "files": {"tracked_count": len(tracked), "sample": tracked[:500], "truncated": len(tracked) > 500},
            "structure": [{"path": path, "kind": top[path]} for path in sorted(top)[:200]],
            "analysis": analyze(root, tracked)}


def validate(registry, repository_id, supplied):
    inspection = inspect(registry, repository_id)
    analysis = inspection["analysis"]
    candidates = analysis["candidates"]
    diagnostics = list(analysis["diagnostics"])
    if supplied is None and len(candidates["app"]) == len(candidates["tests"]) == len(candidates["health"]) == 1:
        supplied = AdapterConfig(adapter="fastapi-sqlite-v1", app=candidates["app"][0]["target"],
                                 tests=candidates["tests"][0]["path"], health_path=candidates["health"][0]["path"],
                                 state_env="PARADOX_APP_DIR")
    if supplied is None:
        diagnostics.append(diagnostic("configuration_required", "Provide an explicit supported adapter configuration"))
    else:
        root = Path(inspection["repository"]["root"])
        for value in (supplied.working_dir, supplied.tests):
            path = PurePosixPath(value)
            if not value or "\\" in value or "\x00" in value or path.is_absolute() or ".." in path.parts:
                diagnostics.append(diagnostic("unsafe_configuration_path", "Configuration paths must stay within the repository"))
                continue
            actual = root / value
            if not actual.is_dir() or any(parent.is_symlink() for parent in (actual, *actual.parents)):
                diagnostics.append(diagnostic("invalid_project_directory", "Configured directories must exist without symlinks"))
        if supplied.working_dir != ".":
            diagnostics.append(diagnostic("unsupported_working_directory", "M1 supports single-root Python projects only"))
        if not any(item["target"] == supplied.app for item in candidates["app"]):
            diagnostics.append(diagnostic("unsupported_app", "App must match a statically detected FastAPI entrypoint"))
        if not any(item["path"] == supplied.tests for item in candidates["tests"]):
            diagnostics.append(diagnostic("unsupported_tests", "Tests must match a tracked test-directory candidate"))
        if not any(item["path"] == supplied.health_path for item in candidates["health"]):
            diagnostics.append(diagnostic("unsupported_health", "Health path must match a statically detected endpoint"))
        if not supplied.health_path.startswith("/") or supplied.health_path.startswith("//") or any(character in supplied.health_path for character in ("?", "#", "\\", "\x00", "\r", "\n")):
            diagnostics.append(diagnostic("unsafe_health_path", "Health endpoint must be a local absolute URL path"))
        if any(item.get("env") != supplied.state_env for item in candidates["state"] if item["kind"] == "sqlite"):
            diagnostics.append(diagnostic("unisolated_state", "SQLite state must use PARADOX_APP_DIR"))
    if analysis["status"] == "unsupported":
        diagnostics.append(diagnostic("unsupported_project", "Only the fastapi-sqlite-v1 adapter is supported"))
    if inspection["git"]["dirty"]:
        diagnostics.append(diagnostic("dirty_working_tree", "Inspection includes current tracked working files, not only HEAD", "warning"))
    diagnostics.append(diagnostic("static_validation_only", "No commands executed; runtime, dependency and isolation checks remain required before execution", "info"))
    return {"repository": inspection["repository"], "valid": not any(item["severity"] == "error" for item in diagnostics),
            "configuration": supplied.model_dump() if supplied else None, "diagnostics": diagnostics}


def command_templates(configuration):
    return {"start": ["{python}", "-m", "uvicorn", configuration.app, "--host", "127.0.0.1", "--port", "{port}"],
            "test": ["{python}", "-m", "pytest", "--noconftest", "-p", "no:cacheprovider", "-c", "{null_config}", configuration.tests],
            "validation": ["{python}", "-m", "compileall", "-q", "."]}
