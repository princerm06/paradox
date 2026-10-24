# M1 static repository analysis

Owner: Codex 1. `engine/project_analysis.py` is independent of repository
registration, Git discovery, configuration validation, runtime execution and
generation. Codex 2 owns the repository API and passes its authorized canonical
root plus the tracked paths returned by hardened Git discovery. The architect's
`docs/contracts/m1-projects.md` is the shared contract; this document describes
the implementation, not a replacement API.

## Integration boundary

```python
from engine.project_analysis import inspect_project

analysis = inspect_project(canonical_root, tracked_files)
```

The callable requires both arguments. It returns a JSON-compatible dictionary
with schema `paradox.project-analysis/v1`, never a runnable adapter or command.
It has no HTTP routes, registry, subprocess, Git, agent or provider dependency.
The caller must authenticate/authorize access, establish the Git root, and bound
Git discovery separately. The module never enumerates directories. Files absent
from `tracked_files` cannot influence results. Its own additional file-count
limit also applies to the supplied list, including non-source files.

ProjectAnalysis contains:

- `status`: `supported`, `requires_configuration`, or `unsupported`.
- `adapter`: `fastapi-sqlite-v1` for a recognized Python/FastAPI project, else null.
- `runtime`: language, framework, and any statically recognized Python requirement.
- `dependencies`: tracked manifest paths and kinds, not installed dependencies.
- `candidates.app`: module targets, source paths and short static evidence.
- `candidates.tests`: pytest directory/file paths; no tests run during discovery.
- `candidates.health`: literal GET `/health`, `/healthz`, and `/api/health` routes
  on statically recognized FastAPI handles.
- `candidates.state`: SQLite path/environment evidence, not a proven state mapping.
- `diagnostics`: deterministic code/severity/message/relative-source-path objects.

No timestamps, local absolute paths, source snippets, secret values, `.env`
contents, inferred shell scripts, or executable recommendations are returned.
Health URL paths such as `/health` are URL paths, not local filesystem paths.
An absolute hard-coded SQLite path is not echoed; its candidate path is null.

## Capability matrix

| Project shape | Static capability |
| --- | --- |
| One module-level FastAPI app, declared FastAPI dependency, tracked pytest directory, literal `/health`, and environment-derived SQLite arguments | `supported` |
| The same application without SQLite | `supported` |
| A module app assigned from a simple local factory returning FastAPI | Recognized; the other checks still apply |
| Multiple app candidates, missing declaration/tests/health, only `/healthz` or `/api/health`, hard-coded/unresolved SQLite state | `requires_configuration` with specific diagnostics |
| Recognized app with unsafe/unreadable/malformed/oversized source, incomplete read budget, or changed files | `requires_configuration`, never silently complete |
| Node-only, non-FastAPI Python, or no recognizable Python/FastAPI project | `unsupported` |
| SQLAlchemy backend without a literal SQLite URL, or known external-state imports | `requires_configuration` for explicit adapter review |

`supported` means only that the frozen **static shape** matches this narrow
adapter. It does not validate `paradox.json`, prove configuration validity,
check installed packages/Python compatibility, start a server, run pytest,
prove that an environment variable controls every write, or permit adoption.
Configuration validation overlays the report separately. The analyzer deliberately
does not read `paradox.json`; both configuration parsing and derived fixed
commands belong to Codex 2. Opening an imported project for real execution,
database migration/backup policy, and runtime isolation remain later milestones.

## Detection details

Python is parsed with `ast.parse` under the engine's Python 3.9-compatible
implementation. Direct and aliased `FastAPI()` assignments and simple local
factories are recognized without importing any package. Tests are identified
from tracked `tests/` paths and pytest filename conventions. Test code is not
treated as a runtime application. Dynamic entrypoints, cross-module factories,
routers with dynamic prefixes, complex custom startup, and newer Python syntax
may require manual configuration rather than guessing.
Module targets are relative to the repository root: a src-layout app is reported
as `src.pkg.main:app`. The configuration validator must explicitly map its
working directory and entrypoint rather than assuming a `src` import root.
Routes declared on `APIRouter` or attached using `include_router` are not
resolved, even with literal prefixes; they require manual health configuration.

Dependency declarations are recognized in `requirements*.txt`, PEP 621
`[project].dependencies`, Poetry dependencies, `setup.cfg`, and Pipfile packages.
TOML uses a deliberately small, non-executing string/list subset, not a full
TOML parser. Unsupported forms get a diagnostic, and unrecognized declarations
cannot satisfy the FastAPI dependency check. Requirement includes/editable
dependencies are reported but never followed or installed. `setup.py` is
reported as an `other` manifest and only AST-parsed; it is never evaluated.
Python version strings are declarations, not a dependency/interpreter resolution.

SQLite evidence covers direct/aliased sqlite3 and aiosqlite connections, simple
assignment and local argument flow, and literal SQLite SQLAlchemy URLs. Env
reads in these argument expressions are reported as static evidence; an
unrelated env read does not qualify a hard-coded connection. Name binding and
data flow are intentionally conservative syntactic approximations, not a
whole-program analysis. Custom wrappers, hidden state, conditional fallbacks,
dynamic imports, background writers and external services still need manual
review before any future execution. A static match cannot prove isolation.

## Read safety and limits

- Only whitelisted tracked Python/manifest paths are opened. `.env`, arbitrary
  documents, Git metadata, databases and package scripts are never opened.
- Absolute/traversal/invalid paths are rejected without echoing the unsafe value.
- Realpath containment is checked. Every ancestor and file is then opened with
  `O_NOFOLLOW` using directory descriptors, including a symlink-swap regression.
  Even in-root symlinks are rejected. This POSIX read strategy is tested on macOS.
- Only regular files are read; nonblocking opens reject FIFOs without hanging.
- Limits: 4,096 supplied tracked paths, 256 KiB per file, 4 MiB total contents.
  The path-count cap applies before source filtering, so asset-heavy repositories
  exceeding it are conservatively incomplete even with few Python files. A
  future separate raw-list and relevant-source cap can relax this limitation.
  Oversized files are rejected from stat metadata before reading their payload.
  Actual read bytes consume the shared budget even if a file changes mid-read.
- Per-file analysis also caps 50,000 AST nodes and 10,000 state-flow operations;
  pathological assignment graphs fail with `analysis_complexity_limit` rather
  than expanding indefinitely. Repeated TOML dependency keys are rejected.
- UTF-8 decoding uses replacement with a diagnostic. Parsing and file failures
  never include exception text that could expose source or an absolute path.
- A size/mtime change or incomplete file read asks the caller to retry.
  There is no content, configuration, index, dependency or bytecode write.
  Ordinary reads may affect filesystem access times; they are not a snapshot
  or a lock against a concurrent working-tree editor.

## Validation

Disposable tmp-built project fixtures need no nested Git repositories. Tests
cover supported shape, ambiguous apps, health alternatives, hard-coded state,
unsupported stacks, malformed Python/manifests, invalid UTF-8, unsafe paths,
symlinks and parent swaps, FIFOs, file/total/count bounds, no directory walking
or subprocesses, import/setup/test execution markers, unchanged source hashes
and mtimes, private-file exclusion, factory aliases, manifest subsets, external
state, and deterministic JSON output.

```sh
env -u FACTORY_API_KEY .venv/bin/python -m pytest tests/test_project_analysis.py -q
```

Focused result: **38 passed**. No Factory call, credential access,
dependency install or imported-project execution is part of these checks.
Any warning or error conservatively prevents `supported`, including dependency
indirection, decoding replacement and external-state evidence.

Final full offline regression with `FACTORY_API_KEY` unset:
`env -u FACTORY_API_KEY .venv/bin/python -m pytest -q` — **260 passed,
2 skipped in 330.89s**. This covers the final analyzer complexity hardening.
