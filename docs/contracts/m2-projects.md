# Projects M2 contract: alternate futures for an imported repository

Status: **frozen v1** (2026-10-24), after review by Codex 1 and Codex 2. **v1.1** (2026-10-24): single-process execution clarification and the open P1 record. Base is M1 at `feat/local-repository-m1` @ 7c79aa6. Changes need agreement from all three. Not to be confused with `m2-generation.md`, the earlier demo milestone. That contract and every route in it stay exactly as they are.

## Goal

A user selects a supported local Git repository and Paradox:
1. imports a private copy
2. creates an isolated alternate future
3. generates a code change with the **scripted** provider
4. validates it
5. previews it
6. switches between futures, each with its own application state

Scope:
- **Supported:** only `fastapi-sqlite-v1` repositories that M1 validates as `valid:true`. No promise of arbitrary repository support.
- **Not in scope:** Droid or other paid providers on imported projects, dependency installation, writing back to the source repository, any remote Git or GitHub operation, OAuth.

## Invariants (P0, each has a test)

1. **The source repository is never written.** Import reads committed blobs with hardened, sandboxed git (M1 rules).
   - Test: the work tree, `.git/index`, refs and the object store are byte-identical before and after import, generation, activation and deletion.
2. **Nothing from a repository executes before trust.** Trust is explicit and per repository, recorded only through the native shell or operator configuration (§ Trust). Import, Original-timeline boot, tests and preview all require it.
3. **Imported code always runs inside the execution sandbox** (§ Execution). If the sandbox is unavailable, the operation fails closed with 503. The bundled demo keeps `trusted_local`.
4. **Each timeline has its own code and state directories.** Snapshots copy SQLite with the backup API. Writes in one future are never visible in another.
5. **The demo is untouched.**
   - The existing `/api/*` routes, schemas, state layout and scripted recipes keep working unchanged.
   - The full suite, the Gate A browser rehearsal and `npm run test:desktop` (5/5) pass at every merge.
6. **Pages never send filesystem paths.** All routes take opaque ids (M1 rule).

## Lifecycle

```text
register (M1) → inspect (M1) → validate (M1, saves config) → trust (native) → import → Original boots (sandboxed)
  → generate (scripted) → validate (guard, compile, tests, boot, smoke) → pending future → preview / make live → switch
```

Restart: projects, timelines, snapshots and generations persist. No project runtime starts automatically. The page calls `open` again.

## Project Adapter v1

The frozen interface is `engine/adapters/base.py` (Claude). The engine reads every project-specific value from a `ProjectProfile` instead of hard-coding `demo_app`:

| Field | Demo (`DEMO_PROFILE`, today's behaviour) | `fastapi-sqlite-v1` (from saved AdapterConfig) |
|---|---|---|
| `app` | `demo_app.main:app` | `config.app` |
| `compile_paths` | `demo_app` | top-level package of `config.app` |
| `tests` | `demo_app/tests` | `config.tests` |
| `health_path` / `smoke_paths` | `/health` / `/health`, `/api/posts` | `config.health_path` / `config.health_path` |
| `state_env` | `PARADOX_APP_DIR` | `PARADOX_APP_DIR` (only value M1 accepts) |
| `editable_prefixes` | `demo_app/` | `""` (the whole imported tree) |
| `immutable_paths` | `demo_app/AGENTS.md` | dependency manifests found by analysis (`requirements*.txt`, `pyproject.toml`, `setup.cfg`, `setup.py`, `Pipfile*`) |
| `protected_tests_prefix` | `demo_app/tests/` | `config.tests + "/"` |
| `sqlite_state_globs` | `app.sqlite3` | `*.sqlite3`, `*.sqlite`, `*.db` (top level of state) |
| `execution` | `trusted_local` | `sandboxed` |
| `providers` | `scripted`, `droid` | `scripted` only |

Rules:
- **`immutable_paths` matching (clarification, 2026-10-24):** uses `fnmatchcase`.
  - A pattern containing `/` matches the full relative path.
  - A pattern without `/` matches the basename at any depth. For example, `requirements*.txt`, `Pipfile*`, `setup.py`, `setup.cfg` and `pyproject.toml` are protected in every directory.
- **Launchers (clarification, 2026-10-24):** every engine-owned `python -c` launcher whose cwd may hold untrusted code runs with `-I` (`JobControl.run`). For sandboxed profiles, the whole process argv goes through `exec_sandbox.wrap`, including the runtime launcher, which imports the app from its cwd on purpose.
- **Validation tooling must not be shadowable (clarification, 2026-10-24):** the validation bootstrap (compile, pytest collection and tests) runs as `python -I`, so cwd is not on `sys.path`.
  - It imports its tooling (pytest, compileall, junit handling) **before** making project code importable.
  - It then **appends** the code root to `sys.path`. It never prepends, so stdlib and site-packages always win.
  - pytest runs with `--import-mode=append`.
  - A generated root-level `pytest.py` or `compileall.py`, or a stdlib-named module, therefore cannot replace the validator.
  - Residual risk (documented, not a security boundary): code under test runs in the same process as pytest, so adversarial code could still forge its own test outcome or report. The **sandbox** is the security boundary, and validation is evidence. In M2 only the scripted provider generates code.
- Command argv stays as fixed templates in engine code: uvicorn `--fd`, `compileall`, and pytest through `TEST_BOOTSTRAP`, with baseline `conftest.py` files taken from the base snapshot. Profiles supply only paths and the target.
- Validation keeps its current semantics: the test count must not drop, existing tests are immutable, source must not change during validation, and generated bytecode is rejected.
- **Preflight runs before any execution.** It never imports project code.
  - For each declared dependency, it checks that the engine interpreter can resolve the **top-level** module (`importlib.util.find_spec(name)`, with a small name map, e.g. `python-multipart` → `multipart`).
  - It is called only with top-level names, never dotted names, because `find_spec("a.b")` imports `a`.
  - The engine process's `sys.path` never contains the project.
  - A missing dependency gives the error `dependency_unavailable`. A project top-level module or package with the same name as a dependency gives the error `dependency_shadowed`. Either blocks import.
  - **M2 never installs packages.**
- **Application state.**
  - The application may write only inside `PARADOX_APP_DIR`. The sandbox enforces this: any other write fails, so the app has no other writable path.
  - Snapshots copy the whole state tree.
  - `sqlite_state_globs` are **recursive** patterns relative to state (`**/*.sqlite3`, `**/*.sqlite`, `**/*.db`). Matching files are copied with the SQLite backup API, and their `-wal`, `-shm` and `-journal` files are dropped.
  - A hard-coded SQLite path is already `requires_configuration` in M1, so it is never `valid:true`.

## Import

`POST /api/projects {repository_id}`, then:
1. Requires a saved successful configuration (`valid:true` on re-validation now) and trust for that `(repository id, configuration hash)`.
2. Reads `HEAD` with `git ls-tree -r -z --full-tree HEAD` plus `git cat-file --batch`, using the hardened argv, env and sandbox.
   - It does **not** use `git archive` or checkout. They apply `.gitattributes` filters, which can run configured programs.
   - Blobs are written into Paradox state: `<state>/projects/<project_id>/import/code/`.
3. Rejects the following, with diagnostics:
   - symlinks (mode `120000`), submodules (`160000`), non-UTF-8 or unsafe paths
   - more than 10,000 files, a file over 1 MiB, or more than 50 MiB in total
   - an unborn `HEAD`
4. Uncommitted changes are **not** imported. A dirty work tree gives the warning `uncommitted_changes_ignored`, and `base.dirty` is recorded.
5. **Re-validates the imported copy, not the working tree.**
   - Runs `inspect_project` on the copy and the M1 validation of the saved configuration against that result.
   - Anything other than `valid:true` returns 422 `validation_required`.
   - M1 analysis of a dirty working tree never authorizes execution by itself.
6. Runs preflight on the copy, then creates the project engine:
   - Original timeline = imported code plus empty state
   - boots sandboxed and must pass `health_path`
   - snapshot taken
   - Failure leaves no project record (atomic; staging directory removed).

There is one project per repository in M2. A second import returns 409 `project_exists`.

## Trust

- `POST /api/repositories/{id}/trust {}` requires the bearer token **and** `X-Paradox-Shell-Token`. Desktop: a new Tauri command, `trust_repository(id)`. Steps:
  1. It shows a native confirmation stating exactly what will run: "Paradox will run this project's tests and server with Paradox's Python, sandboxed, with no network access except localhost."
  2. Then it posts.
- **Browser mode:** trust only through operator configuration, `PARADOX_TRUSTED_REPOSITORY_ROOTS` (same format as `PARADOX_REPOSITORY_ROOTS`, entries must also be registered roots). There is no page route that grants trust.
- **Trust is bound to the configuration hash.** A changed saved configuration or a forgotten repository revokes it. It is stored in `repositories.json` next to the saved config (Codex 2).
- `DELETE /api/repositories/{id}/trust` (shell token) revokes trust. Revocation is immediate:
  1. It stops the project's preview runtime.
  2. It cancels the project's running generations (stage `engine`, message "trust revoked").
  3. It sets status `unavailable`.
  Project data is kept, but `open`, generate, activate and restore return 403 `trust_required` until trust is granted again.

## Execution sandbox (imported projects)

Every imported-code process runs under `sandbox-exec`: the Original boot, pytest, the validation boot and the preview runtime.
- **Network:** denied, except binding and connecting on 127.0.0.1.
- **Writes:** denied, except the paths passed to `exec_sandbox.wrap(argv, writable)`.
  - Each entry is an existing directory (allowed as `subpath`) or an exact file (allowed as `literal`).
  - The caller passes only the run's own `state/` or `test-state/`, the exact JUnit report file, and a private per-run `tmp/` under the validation root.
  - The timeline's `code/` is **read-only** during compile, tests, validation and preview.
  - Sandboxed runs set `PYTHONPYCACHEPREFIX=<run tmp>/pycache` and `TMPDIR=<run tmp>`, so `compileall` and imports write no bytecode into `code/`. The demo's `trusted_local` environment is unchanged.
- **Exec:** only the engine interpreter (realpath of `sys.executable`).
- **Reads (P0):** `(deny file-read* (subpath $HOME))`, then allow back only:
  - the `$HOME` literal
  - the engine venv `site-packages` (realpath)
  - the run's own root
  - the interpreter prefix, if it is under `$HOME`

  Reason: a preview or test response on localhost could disclose a readable secret even with outbound traffic blocked. The engine state directory outside the run root is denied as well.
- **Environment:** the existing `scrubbed_environment()` with `PARADOX_APP_DIR` set. No `FACTORY_API_KEY`, `PARADOX_TOKEN` or shell token.
  - **Gate (added 2026-10-24):** the live demo runtime on main inherits the full engine environment (reproduced with sentinels). No imported-project execution merges until the runtime env-scrub fix merges.
  - Every sandboxed-run test asserts that sentinel `FACTORY_API_KEY`, `PARADOX_TOKEN`, `PARADOX_SHELL_TOKEN` and `ANTHROPIC_API_KEY` are absent from the child environment.
- **Required tests:** a fixture app whose import-time code tries to write outside state, to open an outbound socket, and to exec `/bin/sh`. All three are blocked, and the run fails or continues according to the test.

Verified by Claude on 2026-10-24 (macOS, CLT Python 3.9, engine venv). pytest passed and uvicorn served `/health` under the profile; a SQLite write to state succeeded; `$HOME` write and `/bin/sh` exec were blocked. Two traps the profile must avoid:
- **The network rule.** `(allow network* (local ip "localhost:*"))` **lets outbound connections to 1.1.1.1 through.** Use exactly:
  ```
  (deny network*)
  (allow network-bind (local ip "localhost:*"))
  (allow network-inbound (local ip "localhost:*"))
  (allow network-outbound (remote ip "localhost:*"))
  ```
  This blocks outbound traffic to non-loopback hosts and keeps loopback bind, accept and connect working.
- **The exec allowlist.** Framework Python re-execs `<prefix>/Resources/Python.app/Contents/MacOS/Python`. The allowlist needs that literal as well as `realpath(sys.executable)`. Otherwise every run fails with `posix_spawn`.
- **Python path.** Pass the engine venv `site-packages` through `PYTHONPATH`, because the realpath interpreter is not the venv shim.
- **Home read-deny.** Verified with the rules above: pytest and uvicorn ran normally, and `compileall` with `PYTHONPYCACHEPREFIX` left no `.pyc` in `code/`. Reads of `~/.zshrc`, `~/Library/Keychains` and the Paradox checkout returned `PermissionError`.

Import evidence (same date): with a `.gitattributes` smudge filter configured, `git archive HEAD` **ran the filter**, which wrote a marker. `ls-tree` plus `cat-file --batch` did not.

### Clarification v1.1: single-process execution (2026-10-24)

Agreed after the detached-child finding on 8e66728: an imported app could `Popen(..., start_new_session=True)` and the child survived `Engine.close()`, still writing its former future's state. `killpg` only reaches the original process group.

- The imported-project profile adds `(deny process-fork)`. M2 supports **single-process** FastAPI/SQLite apps only: uvicorn without `--workers`/reload, in-process pytest, no subprocess spawning from app or test code.
- This **supersedes** the earlier positive requirement that a sandboxed parent can signal a sandboxed child. `(deny signal)` with `(allow signal (target same-sandbox))` stays.
- Every sandboxed process is started by the trusted supervisor (`engine/runtime_supervisor.py`) in its own session. Close, switch, revoke, cancel and engine death terminate and reap it, and a SIGTERM-ignoring writer is killed before state is copied or restored.
- Also in the profile, beyond the original text above: `(deny mach-lookup)`, `(deny user-preference-read)`, `(deny process-info*)` except self, and `(deny sysctl-read)` except `kern.ostype`, `kern.hostname`, `kern.osrelease`, `kern.version`, `hw.machine`, `hw.ncpu`. Consequence: no DNS inside the sandbox; apps must use `127.0.0.1`.
- **Required tests:** `Popen(start_new_session=True)`, `os.fork` and `posix_spawn` from app and test code are denied; a fixture with a SIGTERM-ignoring writer leaves no process and no late write after close/switch/revoke.
- Multi-process apps need a whole-sandbox process supervisor and a new contract revision.

The agent (Droid) sandbox for imported projects is a separate profile, specified in `docs/m2c-agent-security.md` (PR #27). It must not relax anything in this section.


## HTTP API

**Authentication:**
- Every `/api/projects/*` route requires the bearer token, **GET included** (same as `/api/repositories`). The Origin guard applies.
- Shell-token routes are marked "shell".
- Errors are `{"detail": {"code", "message"}}` (M1 repository shape).

**Project management:**

| Method | Path | Auth | Response |
|---|---|---|---|
| POST | `/api/repositories/{id}/trust` `{}` | token + shell | `200 RepositoryTrust` |
| DELETE | `/api/repositories/{id}/trust` | token + shell | `204` |
| GET | `/api/projects` | token | `{projects: [Project]}` |
| POST | `/api/projects` `{repository_id}` | token | `201 Project` |
| GET | `/api/projects/{pid}` | token | `Project` |
| POST | `/api/projects/{pid}/open` `{}` | token | `Project` (starts the preview runtime of the active timeline; at most one open project, so opening another closes the previous one) |
| POST | `/api/projects/{pid}/close` `{}` | token | `Project` |
| DELETE | `/api/projects/{pid}` | token + shell | `204` (deletes Paradox-owned state only) |

**Timeline routes.** These are the existing demo routes, mirrored under `/api/projects/{pid}` with **identical request and response schemas**, so Studio reuses its client by swapping the base path:

| Mirrored route | Notes |
|---|---|
| `GET timelines` | |
| `POST timelines/{tid}/activate` | |
| `POST timelines/{tid}/confirm` | |
| `POST timelines/{tid}/decline` | |
| `GET timelines/{tid}/snapshots` | |
| `POST timelines/{tid}/snapshots` | |
| `POST timelines/{tid}/restore` | |
| `GET agents` | Returns only `scripted` as available. |
| `POST generations` | `provider` must be `scripted`; anything else returns 422 `provider_unsupported` before a job exists. |
| `GET generations` | |
| `GET generations/{gid}` | |
| `GET generations/{gid}/logs` | |
| `GET generations/{gid}/diff` | |
| `POST generations/{gid}/cancel` | |

`timelines/sprout` is **not** mirrored: its modification types are demo-specific.

**Schemas:**

```text
Project = {
  id, repository_id, name, adapter: "fastapi-sqlite-v1",
  configuration: AdapterConfig,                 # as saved at import
  base: {commit: sha, branch: str | null, dirty: bool},
  created_at,
  status: "ready" | "open" | "unavailable",     # unavailable = trust revoked or sandbox missing
  active_timeline_id,
  runtime: {status: "stopped" | "starting" | "running" | "failed",
            url: "http://127.0.0.1:<port>/" | null,   # preview iframe URL
            timeline_id: str | null}
}
RepositoryTrust = {repository_id, configuration_hash, granted_at, source: "picker" | "configured"}
```

Errors (in addition to M1's):
- 403 `trust_required`
- 409 `project_exists`, `project_busy`
- 422 `validation_required`, `dependency_unavailable`, `import_rejected`, `provider_unsupported`
- 503 `execution_sandbox_unavailable`

## Scripted provider on imported projects

- Recipes may add `"adapter": "fastapi-sqlite-v1"` and `"requires": [rel, ...]`.
  - A project engine considers only recipes with a matching `adapter` whose `requires` files all exist in the base.
  - The demo engine ignores recipes that have an `adapter` key, so today's recipe behaviour is byte-identical.
- Fixture recipes live in `tests/fixtures/scripted_agent/projects/` and target the disposable fixture below. Codex 1 owns them. Required outcomes:
  - success (a feature plus a new test)
  - compile failure
  - test failure
  - guard failure (edits an existing test, or a dependency manifest)
  - slow and cancellable

## Lane interfaces (Python, frozen)

These are the only cross-lane call points. Everything else is private to its owner.

```python
# engine/adapters/exec_sandbox.py (Codex 2)
def availability_reason() -> Optional[str]                    # None means usable. Otherwise operations fail closed with 503.
def wrap(argv: Sequence[str], writable: Sequence[Path], run_root: Path) -> List[str]
    # sandbox-exec argv. Reads allowed: run_root, venv site-packages, interpreter prefix.
    # writable: existing dirs become subpath rules, existing files become literal rules. Nothing else.
def environment(base: Mapping[str, str], run_tmp: Path) -> Dict[str, str]
    # base + PYTHONPATH (venv site-packages and cwd), TMPDIR, PYTHONPYCACHEPREFIX, HOME=run_tmp.

# engine/adapters/fastapi_sqlite.py (Codex 2)
ADAPTER: ProjectAdapter                                       # id "fastapi-sqlite-v1". See base.py.

# Constructors (Codex 2). The default profile keeps the demo byte-identical.
Engine(root, demo_source, runtime_port, profile: ProjectProfile = DEMO_PROFILE)   # engine.profile
Runtime(root, port=8001, environment=None, control=None, profile=DEMO_PROFILE)
    # For "sandboxed" profiles, start() launches via wrap(): writable = [workspace/state, run tmp].
    # Health probe uses profile.health_path.
Generations(engine)                                           # reads engine.profile. adopt() unchanged in shape.

# Codex 1. Each takes the profile explicitly, and DEMO_PROFILE reproduces today's behaviour.
guard(base, current, changed, profile)
baseline_test_count(directory, base, control, log, profile)
validate_runtime(directory, code, base_state, control, log, record_check, profile)
    # Builds its Runtime with the same profile, so sandboxing comes from Runtime.
Providers.run(provider, prompt, code, control, log, profile)  # rejects providers not in profile.providers
    # Recipe filter: the "adapter" key must equal profile.adapter (no key means demo-v0); "requires" files must exist.
# run(): compile and pytest commands go through exec_sandbox.wrap/environment when profile.execution == "sandboxed".
#   writable = [test-state dir, exact report file, run tmp]. code/ is never writable.

# engine/projects (Codex 2)
class Projects:                                               # one per app, owns per-project Engine and Generations
    def list(self) -> List[dict]; def get(self, pid) -> dict
    def create(self, repository_id) -> dict                   # import (§ Import), atomic
    def open(self, pid) -> dict; def close(self, pid) -> dict  # at most one open
    def delete(self, pid) -> None
    def engine(self, pid) -> Tuple[Engine, Generations]       # used by the mirrored routes
    def revoke(self, repository_id) -> None                   # close runtime, cancel generations, status unavailable
```

Mirrored routes reuse the existing handler bodies with the project's `(Engine, Generations)` instead of the app-level pair. Project state lives in `<state>/projects/<pid>/`. Each project `Engine` has its own `engine.lock`, `Gate`, `engine.sqlite3`, snapshots and generations, and never touches the demo's files. `Engine.start()` initializes the Original timeline from the import staging copy plus `ADAPTER.initialize_state`, not from `demo_source`.

## Disposable fixture project

`tests/fixtures/projects/build.py::build_notes_repo(tmp_path) -> Path` (Codex 1) creates a fresh Git repository at test time. Nothing with a nested `.git` is committed. The repository contains:
- `notes_app/main.py`: FastAPI with `GET /health`, and `GET/POST /api/notes` backed by SQLite at `os.environ["PARADOX_APP_DIR"]/notes.sqlite3`
- `tests/` with at least 3 tests
- `requirements.txt` listing only modules already in the engine venv (fastapi, uvicorn, httpx, pytest)

Variants for negative tests:
- dirty work tree
- missing dependency
- hostile import-time code (sandbox tests)
- `core.fsmonitor` marker
- symlink and submodule entries

All tests use `tmp_path` state, `runtime_port=0`, the scripted provider and no `FACTORY_API_KEY`.

## Ownership (no shared files without a message first)

| Owner | Files |
|---|---|
| **Codex 2** (M2-B): repositories, import, adapter, sandbox, workspace, state, runtime, API | `engine/repositories/**`, `engine/projects/**` (import, project registry, trust store, router, per-project engine lifecycle), `engine/adapters/**` except `base.py` (`fastapi_sqlite.py`: profile, preflight, initial state; `exec_sandbox.py`: `wrap(argv, writable) -> argv` plus the environment), `engine/service.py`, `engine/storage.py`, `engine/runtime.py`, `generations.py` `adopt()` and constructor, the `api.py` mount lines, `tests/test_repositories*.py`, `tests/test_projects*.py`, `tests/test_project_import*.py`, `tests/test_adapters*.py`, `tests/test_exec_sandbox*.py` |
| **Codex 1** (M2-A): analysis, generation, validation, providers | `engine/project_analysis.py`, `engine/validation.py` (guard, test report, orchestration; it calls `exec_sandbox.wrap` and does not reimplement it), `generations.py` `run()`, `engine/providers.py`, `tests/fixtures/projects/**`, `tests/fixtures/scripted_agent/projects/**`, `tests/test_project_analysis*.py`, `tests/test_project_generation*.py` |
| **Claude**: interface, desktop, cross-component | `engine/adapters/base.py`, `docs/contracts/m2-projects.md`, `apps/desktop/**` (`trust_repository` command, picker wiring), `tests/e2e/**` |
| **Prince**: Studio | `apps/studio/**` (project list, trust status, project-scoped client base, preview iframe) |

Rules:
- `generations.py` stays split exactly as in M3: Codex 1 owns `run()`, Codex 2 owns `adopt()` and the constructor.
- Changes to `api.py` beyond the mount, or to `jobs.py`, need a message to the other agent and to Claude first.

## Delivery order

Each step is a separate local branch, reviewed by Claude. Nothing merges without user approval.

1. **P0 profile refactor, demo-only (Codex 2 and Codex 1, in parallel).**
   - Replace hard-coded `demo_app` with `DEMO_PROFILE`. Codex 2 changes storage, runtime and service; Codex 1 changes validation, `run()` and providers.
   - Acceptance: no behaviour change. Full suite, Gate A and desktop 5/5 unchanged.
2. **Adapter, execution sandbox, preflight (Codex 2). Fixture builder and recipes (Codex 1).** In parallel. The fixture builder lands first, because both sides test against it.
3. **Import, trust store, project engines and router (Codex 2). Project-aware `run()`, guard and validation (Codex 1).** Codex 1 codes against the `wrap` and `ProjectProfile` signatures, with stubs until step 2 lands.
4. **Desktop `trust_repository` and picker → register wiring (Claude),** then Studio project UI (Prince).
5. **Cross-component end-to-end (Claude).** On the fixture:
   - register → validate → trust → import → generate success → preview → make live → write state → switch back → isolation holds → restart → reopen
   - failure recipes rejected
   - source repository byte-identical

## Risks

| Severity | Risk | Control |
|---|---|---|
| P0 | Imported code runs with the user's privileges (tests/server) | Explicit trust, plus the sandbox: network denied and writes restricted |
| P0 | Git filters or hooks execute during import | `cat-file --batch` only; M1 hardening and sandbox |
| P0 | Profile refactor regresses the demo | Step 1 is behaviour-neutral and gated on Gate A plus desktop tests |
| P0 | Reads of `$HOME` from sandboxed code: disclosure is possible through localhost responses | Home read-deny in the profile (verified) |
| P1 | Dependency mismatch between the project and the engine venv | Preflight blocks; no installs in M2 |
| P1 | Long-lived preview runtimes | At most one open project; closed on shutdown |
| P2 | Large repositories | Import caps |

### Open P1: unsandboxed demo code can read the engine's launch environment (recorded 2026-10-24, not in M2 scope)

**Status:** open, documented, not scheduled. Expanding M2 scope needs the user's approval.

**What:** the bundled demo profile is `trusted_local`. The live runtime and the validation runs (compile, pytest, boot) execute generated `demo_app` code unsandboxed, as the user's uid. Such code can read the engine process's **exec-time** environment via `sysctl KERN_PROCARGS2` or `ps eww <engine pid>`.
- PR #25 removes *inheritance* into child environments, which is still required.
- PR #25 cannot change the engine's own exec-time environment block. Neither can removing values from `os.environ` later.

**Exposure today:**

| Setup | Secrets in the engine environment | Who generates code |
|---|---|---|
| Browser demo (documented setup) | `PARADOX_TOKEN` only; keyless engine, no `FACTORY_API_KEY` | Scripted recipes (our fixtures) |
| Desktop | `PARADOX_TOKEN` and `PARADOX_SHELL_TOKEN`; keyless | Scripted |
| Paid Droid runs, user-started with `FACTORY_API_KEY` in the engine env | `FACTORY_API_KEY` | Model-written code, which then runs unsandboxed in validation and live runtime |

So the realistic risk is the paid Droid path: model-written code could read the Factory key. On the desktop, the shell token could also be read once the picker ships.

**Recommended smallest remediation.** Two independent pieces, each small:
1. **Keep secrets out of the engine's exec environment.** The engine reads them once at startup from **stdin**, as one JSON line, and the launcher closes the pipe.
   - The desktop shell already owns stdin for its death-pipe, so it would need a small protocol change.
   - For the browser demo, a documented wrapper pipes the values in.
   - `FACTORY_API_KEY` is instead fetched from the macOS Keychain only at Droid-run time and placed **only** in the Droid subprocess env. That child is already write-sandboxed, but it is not read- or sysctl-sandboxed.
   - Touches: `engine/__main__.py` or startup, `engine/providers.py` (Droid key source), the desktop launcher, the demo checklist. No API or schema change.
2. **Later, separately:** run the demo's validation and runtime under the reviewed `exec_sandbox` as well (a `sandboxed` DEMO profile). This closes the class entirely, but changes demo runtime behaviour, so it needs a full Gate A and desktop re-verification.

Until then: **no paid Droid generations with the key in the engine environment** unless the user explicitly accepts this exposure, and the desktop picker does not ship before item 1, or before the user explicitly accepts the risk.
