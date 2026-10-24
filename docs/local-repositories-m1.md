# Local repositories: M1 implementation notes

The architect-owned API contract is `docs/contracts/m1-projects.md`. This milestone
adds registration, read-only Git inspection and static adapter validation only.
It does **not** open an imported repository in the execution/timeline engine.
Existing demo runtimes, state directories and timeline APIs remain independent.

## Registration and authorization

Every repository route, including GET, requires `PARADOX_TOKEN` as a Bearer token.
Without a configured token these routes fail closed with 401. Existing browser
Origin checks also apply to mutations. All page-facing inspection/validation
requests use opaque repository IDs, not filesystem paths.

Browser/dev setup supplies individual repository roots through
`create_app(repository_roots=[...])` or `PARADOX_REPOSITORY_ROOTS` (OS path separator).
Each root must itself be the Git top level, not a parent directory to browse.
No configured roots means an empty registry; existing demo functionality remains
available. Invalid or stale configured entries are skipped with a warning that
contains only the error code, never the path; other registrations and the demo
continue to start normally.

Native registration is `POST /api/repositories {"path":"/absolute/repo"}`.
It requires both the Bearer token and `X-Paradox-Shell-Token`, checked against
`PARADOX_SHELL_TOKEN`. Unset shell token disables registration/forgetting (403).
The native shell must retain its token outside the page. Never put either token
in logs, screenshots or committed configuration. CORS intentionally does not
allow the shell-token header for browser requests.

Repository IDs are random, in-memory and change when the engine is recreated.
Duplicate roots return 409 with the existing ID. DELETE forgets registration only;
it never removes repository files. Root/home, the engine checkout, engine state
and descendants, relative/traversal paths and external Git-directory layouts are
rejected. Symlink selections canonicalize to a single root identity; subsequent
root replacement by a symlink fails closed.

## HTTP contract

| Method | Route | Request | Response |
| --- | --- | --- | --- |
| GET | `/api/repositories` | No body | `{repositories: [RepositorySummary]}` |
| POST | `/api/repositories` | `{path}`; shell token required | 201 `RepositorySummary` |
| POST | `/api/repositories/{id}/inspect` | `{}` required | `Inspection` |
| POST | `/api/repositories/{id}/validate` | `{}` or `{configuration}` required | `Validation` |
| DELETE | `/api/repositories/{id}` | No body; shell token required | 204 |

Inspect/validate require JSON bodies: clients must send `{}` even without options;
an omitted body returns 422. Request schema errors also return 422. Repository
errors have `detail: {code, message}`; authentication errors use a string detail.
Frontend error codes are:

| Status | Codes |
| --- | --- |
| 400 | `unsafe_path`, `invalid_path` |
| 404 | `unknown_repository` |
| 409 | `already_registered` (message includes existing ID) |
| 422 | `unsupported_git_layout`, `unsafe_git_layout`, `unsafe_git_metadata`, `not_repository_root`, `invalid_repository`, `git_failed`, `git_timeout`, `repository_too_large`, `unsupported_filename`, `unsafe_tracked_path` |
| 503 | `sandbox_unavailable` |

Validation incompatibilities return HTTP 200 with `valid: false` and diagnostics;
they never start or install an application. The architect-owned contract defines
the complete response fields and strict `AdapterConfig` schema.

## Read-only Git boundary

Every Git subprocess uses `/usr/bin/git` inside the existing macOS sandbox facility,
with write permissions only in a private temporary directory (plus `/dev/null`),
network denied, and executable allowlisting for Apple's Git/toolchain launcher.
Repository-configured shell scripts, clean filters and other executables cannot
run. The fixed argv disables fsmonitor, hooks, external diff, pagers, optional
locks and untracked caches; environment/configuration are isolated from the caller.
No source imports, installs, checkout, fetch, LFS or submodule commands occur.
Each call has a 10-second timeout, 4 MB output cap and no shell interpolation.
Repositories exceeding 10000 tracked paths are refused. Inspection samples the
first 500 sorted paths and at most 200 top-level structure entries.

The sandbox is mandatory. Linux/Windows or unavailable/broken `sandbox-exec`
return 503 rather than silently performing unsandboxed Git reads. macOS Git
installations outside Apple's standard CLT/Xcode locations may need a reviewed
executable allowlist extension. Discovery does not change index contents/mtime
or working files; regressions check both and malicious fsmonitor/filter behavior.

## Adapter and compatibility matrix

| Project/layout | M1 result |
| --- | --- |
| Standalone Git work tree, including dirty or detached/unborn HEAD | Read-only inspect supported |
| Single-root Python FastAPI project, one static `module:app`, declared dependencies, tracked tests and literal health endpoint; SQLite using `PARADOX_APP_DIR` or no SQLite | `fastapi-sqlite-v1` static configuration supported |
| Missing/ambiguous static evidence | Requires configuration or invalid validation diagnostics; never guessed execution |
| Django, Flask, Node/React/Next, Docker, external databases/services, monorepo working directories | No supported execution adapter |
| Bare Git, linked worktrees/submodule Git-file roots, external `commondir`, symlink Git metadata | Rejected |
| Non-UTF-8 paths or more than 10000 tracked paths | Rejected |
| Submodules/LFS contents, arbitrary shell/start/test scripts, dependency installation | Not executed/resolved or supported as runtime inputs |
| Non-macOS or unavailable write sandbox | 503, fail closed |

Strict `AdapterConfig` accepts only adapter, app, working_dir, tests, health_path
and state_env from the frozen contract; arbitrary argv and unknown fields are
rejected. `working_dir` is currently restricted to `.`. Test paths must remain
inside real repository directories and match tracked analyzer evidence. Fixed
start/test/compile argv templates are defined in `engine/repositories/inspection.py`
as planning metadata and are **never run** by these endpoints. Future execution
must supply a copied code directory, independent writable state, ephemeral
loopback preview, scrubbed credentials, compile/test/health gates and rollback.

Codex 1 owns `engine/project_analysis.py`; the API passes only Git-tracked paths
to its pure static analyzer. Until that module is integrated, discovery returns
`analysis_unavailable` and validation cannot succeed. No unsupported project is
silently accepted. Static `valid: true` confirms configuration compatibility,
not installed dependencies, actual health, tests passing or proven runtime state
isolation. Every validation response includes this limitation as an info diagnostic.

## Focused checks

```sh
env -u FACTORY_API_KEY python -m pytest -q tests/test_repositories.py
```

Tests create disposable repositories at runtime, never committed nested Git
directories. Coverage includes token/shell/Origin protection, registration and
forgetting, duplicate IDs, clean/dirty/detached/unborn repositories, invalid roots,
traversal, configuration escape/unknown fields, unsupported analysis, sandbox
failure, malicious fsmonitor/clean filters, and unchanged imported files/index.

Remaining boundaries: paths can change concurrently during read-only inspection;
results are observations, not an atomic snapshot. The sandbox enforces writes and
execution restrictions but is not a confidentiality sandbox; Git can read config
and metadata. Future copying/execution must independently revalidate paths and
snapshots, strip credentials (including the native shell token), and implement
actual state isolation. No imported-repository generation or timeline adoption is
enabled by this milestone.
