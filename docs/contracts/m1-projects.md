# M1 contract: local projects (read-only)

Status: **frozen v1.1** (2026-10-24). Changes need agreement from Claude (integration), Codex 1 (analysis) and Codex 2 (repositories). Studio work follows this document.

v1.1 (user request): registrations and successful configurations persist across restarts in `<state>/repositories.json`. Ids are stable. Unavailable roots stay listed. `validate {}` re-checks the saved configuration. Exact behaviour is in Codex 2's `docs/m1-repositories-api.md`, which takes precedence on persistence. Routes and schemas are unchanged.

M1 scope is **read-only discovery** of local Git repositories. Paradox can register a repository, inspect it and say whether it fits the one supported adapter. M1 does not cover:
- generation on imported repositories
- copying, importing or adoption into timelines
- OAuth, remote pushes or pull requests

## Ownership

| Area | Owner | Files |
|---|---|---|
| Git and path layer, registry, models, router | Codex 2 | `engine/repositories/**`, the mount in `engine/api.py` (constructor argument and `include_router` only), `tests/test_repositories*.py` |
| Static project analysis | Codex 1 | `engine/project_analysis.py`, `tests/test_project_analysis.py` |
| Shared fixture builders | Codex 1 + Codex 2 | `tests/fixtures/repos/` (built in `tmp_path` at test time; no committed nested `.git`) |
| Native folder picker | Claude | `apps/desktop/**` |
| Onboarding UI, API client and types | Prince | `apps/studio/**` |
| This contract, cross-component tests, review | Claude | `docs/contracts/m1-projects.md` |

## Trust model

- **Pages never choose filesystem paths.** Every page-facing route takes an opaque repository `id`.
- **Registration** (path → id) is possible only through:
  1. **Startup configuration:** `PARADOX_REPOSITORY_ROOTS` (an `os.pathsep`-separated list), or `create_app(repository_roots=[...])`. Each entry is itself a repository, not a parent directory to browse. Empty by default, so the feature is off.
  2. **The desktop shell:** `POST /api/repositories` with header `X-Paradox-Shell-Token` equal to the engine's `PARADOX_SHELL_TOKEN`.
     - The Rust shell generates that token per launch and passes it only to the engine process. The page never sees it.
     - The path comes from the native macOS folder picker (NSOpenPanel), not from page input.
     - Without `PARADOX_SHELL_TOKEN`, registration returns 403.
- **Every `/api/repositories/*` route requires the bearer token (`PARADOX_TOKEN`), reads included.** The existing Origin guard applies, so another local page, or a DNS-rebinding page, cannot read repository data.
- **A registered path must canonicalise (`realpath`) to the top level of a Git work tree.** Rejected:
  - the filesystem root and `$HOME` itself
  - the engine state directory and anything inside it
  - the Paradox checkout itself

  Error details never reveal more of the filesystem than the caller sent.

## Git execution (hard requirements)

Running `git` on an untrusted repository can **execute repository-configured programs** (`core.fsmonitor`, filters, external diff) and **write `.git/index`**. Verified on 2026-10-24: plain `git status` ran a `core.fsmonitor` script and rewrote the index. The hardened invocation below did neither.

Every git call:
- Uses this argv prefix: `git --no-optional-locks -c core.fsmonitor=false -c core.untrackedCache=false -c core.hooksPath=/dev/null -c core.pager=cat -c diff.external= -c protocol.allow=never`
- Runs with an environment built from scratch: `PATH=/usr/bin:/bin`, `HOME=<empty temp dir>`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `LC_ALL=C`.
- Is read-only only: `rev-parse`, `symbolic-ref`, `status --porcelain=v2 -z --branch`, `ls-files -z`. Never checkout, fetch, submodule or LFS.
- Has a 10 s timeout and capped output, with no shell.
- Runs inside the macOS write sandbox (`engine/droid_sandbox.py` / `sandbox-exec`), with all file writes denied except a private temp directory. If the sandbox is unavailable, the call fails closed (503).

Required tests:
- A repository with `core.fsmonitor` pointing at a marker-writing script must not produce the marker.
- `.git/index` and the work tree must be byte-identical after inspection.

## HTTP API

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/api/repositories` | token | `{repositories: [RepositorySummary]}` |
| POST | `/api/repositories` `{path}` | token + shell token | `201 RepositorySummary` |
| POST | `/api/repositories/{id}/inspect` `{}` | token | `Inspection` |
| POST | `/api/repositories/{id}/validate` `{configuration?}` | token | `Validation` |
| DELETE | `/api/repositories/{id}` | token + shell token | `204` (forgets the registration only) |

Errors:
- `400`: invalid input
- `401`: missing or wrong token
- `403`: shell token missing, registration disabled, or foreign Origin
- `404`: unknown id
- `409`: already registered (detail carries the existing id)
- `422`: not a Git work-tree top level, or a rejected path
- `503`: sandbox unavailable

### Schemas

Relative paths are POSIX and relative to the repository root.

```text
RepositorySummary = {id, name, root (absolute, canonical), source: "configured" | "picker", registered_at}

Inspection = {
  repository: RepositorySummary,
  git: {head: sha | null, branch: str | null, detached: bool, dirty: bool,
        staged: int, unstaged: int, untracked: int, conflicted: int},
  files: {tracked_count: int, sample: [rel] (first 500, sorted), truncated: bool},
  structure: [{path: rel (top level), kind: "file" | "dir"}] (max 200),
  analysis: ProjectAnalysis
}

AdapterConfig v1 (strict, unknown keys rejected) = {
  adapter: "fastapi-sqlite-v1",
  app: "pkg.module:attr",
  working_dir: rel = ".",
  tests: rel = "tests",
  health_path: str = "/health",
  state_env: "PARADOX_APP_DIR"
}
  Commands are fixed templates in engine code (uvicorn, pytest). Config never supplies argv or shell strings.

Validation = {repository: RepositorySummary, valid: bool,
              configuration: AdapterConfig | null (normalised; inferred from analysis when not supplied),
              diagnostics: [Diagnostic]}

Diagnostic = {code: snake_case (stable), severity: "error" | "warning" | "info", message: str, path: rel | null}
```

## Static analysis (Codex 1)

```python
from engine.project_analysis import inspect_project
inspect_project(root: Path, files: Sequence[str]) -> ProjectAnalysis  # JSON-compatible dict
```

- `root` is canonical and registered. `files` is the git-tracked list from the hardened `git ls-files`.
- The function never walks the filesystem, runs git, imports repository code, executes, installs or writes.
- It reads only listed files. It skips symlinks and anything resolving outside `root`. Limits are 256 KiB per file and 4 MiB in total, decoded as UTF-8 with replacement. Parsing is static only (`ast`).
- Output is deterministic and sorted, with no timestamps and no absolute paths.

```text
ProjectAnalysis v1 = {
  schema: "paradox.project-analysis/v1",
  status: "supported" | "unsupported" | "requires_configuration",
  adapter: "fastapi-sqlite-v1" | null,
  runtime: {language: "python" | null, framework: "fastapi" | null, python_requires: str | null},
  dependencies: [{path, kind: "requirements" | "pyproject" | "setup_cfg" | "pipfile" | "other"}],
  candidates: {
    app:    [{target: "pkg.module:attr", path, evidence}],
    tests:  [{path}],
    health: [{path: "/health" | "/healthz" | "/api/health", source}],
    state:  [{kind: "sqlite", path | null, env | null}]
  },
  diagnostics: [Diagnostic]
}
```

Status rules are deliberately narrow:
- **`supported`** needs all of these:
  - exactly one FastAPI app candidate
  - FastAPI declared in dependencies
  - a tests directory
  - a literal `GET /health` route
  - SQLite reached through an environment variable (or no SQLite at all)
- **`requires_configuration`**: a FastAPI app exists but something is ambiguous or missing. Examples:
  - several apps
  - `health_route_missing` (error)
  - `health_path_nonstandard` (warning: only `/healthz` or `/api/health`; settable via `health_path`)
  - a hard-coded SQLite path
- **`unsupported`**: everything else (no Python, no FastAPI, Node and other stacks), with a diagnostic.

State and SQLite findings are **static evidence only**. Analysis does not prove runtime isolation; the adapter has to prove that in a later milestone.

## Desktop shell (Claude)

Implemented on `feat/desktop-repo-picker` (verified in a real WKWebView).

### Trust boundary

| Secret or capability | Holder | The page sees it? |
|---|---|---|
| `PARADOX_TOKEN` (bearer), random 48 hex per launch | Rust shell, engine env, page `localStorage["paradox.token:http://127.0.0.1:8100"]` | Yes, so the page can call the API |
| `PARADOX_SHELL_TOKEN`, random 48 hex per launch | Rust shell memory and engine env **only** | **No** |
| Choosing a filesystem path | Native NSOpenPanel in Rust | No: the page cannot send a path that registers |
| Tauri IPC | Exactly one command, `select_repository`, main window only, origin `http://localhost:5190` | Dialog, fs and shell plugins all denied |

The engine runs as a child process with a cleared environment: no `FACTORY_API_KEY`, `PARADOX_AGENT=scripted`, and state in `~/Library/Application Support/dev.paradox.desktop-poc/state`.

### Command

```ts
const result = await window.__TAURI_INTERNALS__.invoke("select_repository"); // no arguments
```

The page never passes arguments. Results:

| Result | Meaning |
|---|---|
| `{cancelled: true}` | The user closed the dialog |
| `{cancelled: false, already_registered: false, repository: RepositorySummary}` | Engine returned 201 |
| `{cancelled: false, already_registered: true, repository: RepositorySummary}` | Engine returned 409. The shell looks up the existing registration by canonical root. |
| **rejects** with a string | Engine `detail.message` (e.g. "This directory cannot be registered"), "the selected folder is not accessible", or "the engine is not reachable" |

What the shell does:
1. Opens NSOpenPanel and canonicalises the chosen path (`realpath`).
2. Sends `POST /api/repositories {"path": <canonical>}` to `127.0.0.1:8100` over HTTP/1.0, with `Authorization: Bearer` and `X-Paradox-Shell-Token`.
3. Passes the engine's verdict through. All path-safety rules (root, home, state dir, checkout, Git top level) are enforced by the engine, not the shell.

### Verified (2026-10-24, debug selftest in WKWebView)
- First pick: 201. Second pick of the same folder: `already_registered: true`, same id.
- The page's own `POST /api/repositories` with the bearer but no shell token: **403**.
- `plugin:dialog|open`: denied. `plugin:fs|*` and `plugin:shell|*`: "Plugin not found".
- The picked repository is byte-identical afterwards.

### Out of scope until M2
- `trust_repository`: same pattern, adds a native confirmation (see `m2-projects.md`).
- Forgetting a repository from the desktop (DELETE needs the shell token; no command yet).
- **Browser mode** has no picker. The studio lists repositories from `GET /api/repositories` (startup configuration only).

### Precondition
The engine runtime must not inherit `PARADOX_SHELL_TOKEN` (P0 found 2026-10-24: the live demo runtime inherits the engine environment). The picker ships only after that fix merges.

## Studio (Prince)

- **Desktop:** an "Open project" button calls `window.__TAURI_INTERNALS__.invoke("select_repository")` when present.
- **Then, in both modes:** list repositories, inspect one, show the Inspection (git status, structure, analysis status and diagnostics), and optionally validate.
- **No free-text path input.**
- **Every `/api/repositories` call sends the bearer token,** GET included. This differs from the existing GET routes.
- **Exact request and response examples, error codes and persistence behaviour:** `docs/m1-repositories-api.md` on `feat/local-repository-m1` (PR #24).
- **Error shapes differ by layer:**
  - repository errors: `{"detail": {"code", "message"}}`
  - auth and Origin errors: `{"detail": "string"}`
  - schema errors: FastAPI's 422 array

  Branch on HTTP status first, then on `detail.code` when it is an object.

## Merge order

1. This contract.
2. Codex 1 analysis and Codex 2 repositories, developed in parallel. Codex 2 codes against the `inspect_project` signature with a stub until Codex 1 merges.
3. Codex 2 merges after Codex 1, so it can drop the stub.
4. Desktop picker, on `feat/desktop-poc`.
5. Studio onboarding.
6. Cross-component tests (Claude): picker → registration → inspect → validate in the desktop app, plus browser mode with configured roots.

Nothing merges without user approval. The verified browser and desktop demos must keep passing at every step.
