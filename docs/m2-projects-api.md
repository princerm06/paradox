# M2-B implementation contract and readiness

Implementation branch: `feat/project-runtime-lifecycle`. Frozen interface:
`docs/contracts/m2-projects.md`. M1 registration/validation remains documented in
`docs/m1-repositories-api.md`. No UI or imported-source edits are required.

## Readiness: NO-GO

**P1: detached sandbox descendants survive process-group cleanup.** A disposable
imported app can use `subprocess.Popen([sys.executable, "-I", "-c", ...],
start_new_session=True)`. The child remains confined by the inherited sandbox,
but `Engine.close()` kills only the original process group. A detached child can
therefore keep writing its old future's writable state after close, switching or
revocation. This is not an escape to engine secrets; it is a lifecycle and state
integrity failure. The reproduction explicitly kills its disposable detached
process group in `finally`. No probe processes are intentionally left running.

`test_detached_sandbox_child_must_not_survive_runtime_close` is a strict expected
failure, **not evidence of a passing cleanup boundary**. Existing same-group
cleanup and crash tests pass. A successful ordinary HTTP workflow does not
establish adversarial whole-tree cleanup. No release/merge or real repository
execution is recommended until this is resolved.

The frozen contract explicitly permits confined interpreter children. Denying all
fork/spawn operations would narrow that contract and needs coordination/approval;
it has not been silently implemented. A whole-sandbox supervisor must also handle
new sessions, double forks, retained state descriptors and cancellation/revocation
races before claiming general child-process support.

## Authentication and approval

Every repository/project API request, including GET, requires
`Authorization: Bearer <PARADOX_TOKEN>`. Unset token fails closed with 401.
The engine's Origin guard rejects mutation requests with a present Origin outside
`PARADOX_CORS_ORIGINS`, even when bearer and shell credentials are correct.

Registration, forgetting repositories, project deletion and trust changes require
the native-only `X-Paradox-Shell-Token: <PARADOX_SHELL_TOKEN>`. The page must never
receive that token. Unset shell token disables these operations with 403.
Browser operators may explicitly configure `PARADOX_REPOSITORY_ROOTS` and
`PARADOX_TRUSTED_REPOSITORY_ROOTS`; trusted roots must also be registered. Operator
trust applies to a saved configuration, not arbitrary page-supplied paths.

Registration/inspection/validation never execute imported code. An explicit trust
grant plus project creation is required before the sandboxed initial boot.

## Requests and responses

Native registration:

```http
POST /api/repositories
Authorization: Bearer <engine-token>
X-Paradox-Shell-Token: <native-shell-token>
Content-Type: application/json

{"path":"/tmp/notes-repo"}
```

201 uses the unchanged M1 RepositorySummary, for example:

```json
{"id":"AbCdEf012345","name":"notes-repo","root":"/private/tmp/notes-repo","source":"picker","registered_at":"2026-10-25T02:00:00+00:00"}
```

Inspection/validation use registered IDs only and require JSON bodies:

```text
POST /api/repositories/AbCdEf012345/inspect   {}
POST /api/repositories/AbCdEf012345/validate  {}
```

A supplied validation configuration is strict; no shell/argv fields are accepted:

```json
{"configuration":{"adapter":"fastapi-sqlite-v1","app":"notes_app.main:app","working_dir":".","tests":"tests","health_path":"/health","state_env":"PARADOX_APP_DIR"}}
```

Only successful configuration validation persists. Native trust:

```text
POST /api/repositories/AbCdEf012345/trust {}   (bearer + shell token)
```

200:

```json
{"repository_id":"AbCdEf012345","configuration_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","granted_at":"2026-10-25T02:00:00+00:00","source":"picker"}
```

The example hash is illustrative; the actual value is SHA-256 of the normalized,
sorted configuration JSON. Configuration changes remove trust, including when a
later change restores the old configuration. Forgetting also revokes trust.

Project creation:

```text
POST /api/projects {"repository_id":"AbCdEf012345"}
```

201, after a successful initial sandboxed health check and checkpoint:

```json
{
  "id":"0123456789abcdef0123456789abcdef",
  "repository_id":"AbCdEf012345",
  "name":"notes-repo",
  "adapter":"fastapi-sqlite-v1",
  "configuration":{"adapter":"fastapi-sqlite-v1","app":"notes_app.main:app","working_dir":".","tests":"tests","health_path":"/health","state_env":"PARADOX_APP_DIR"},
  "base":{"commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","branch":"main","dirty":false},
  "created_at":"2026-10-25T02:00:00+00:00",
  "status":"ready",
  "active_timeline_id":"11111111-1111-1111-1111-111111111111",
  "runtime":{"status":"stopped","url":null,"timeline_id":null}
}
```

`GET /api/projects` returns `{"projects":[Project]}`; GET `/{pid}` returns Project.
Neither boots imported code. POST `/{pid}/open {}` starts the active timeline's
runtime; its URL is `http://127.0.0.1:<port>/`. At most one imported project is open;
opening/importing another closes the previous one. The bundled demo is separate.
POST `/{pid}/close {}` checkpoints and closes it. DELETE `/{pid}` requires the
shell token, returns 204, and deletes only Paradox-owned project state.

All mirrored routes below require an **explicitly open** project; otherwise 409
`project_busy` ("Project is closed; open it first"). GET never implicitly runs code.
Request/response schemas match their demo counterparts; there is no sprout route:

| Method | Under `/api/projects/{pid}` | Body/result |
|---|---|---|
| GET | `/timelines` | TimelineList, with the project's preview URL |
| POST | `/timelines/{tid}/activate`, `/confirm`, `/decline` | Timeline |
| GET / POST | `/timelines/{tid}/snapshots` | SnapshotList / 201 Snapshot |
| POST | `/timelines/{tid}/restore` | `{"snapshot_id":"..."}` → Timeline |
| GET | `/agents` | `{"default":"scripted","providers":[{"id":"scripted","available":true,"reason":null}]}` |
| POST | `/generations` | GenerationRequest → 202 Generation |
| GET | `/generations`, `/generations/{gid}` | GenerationList / Generation |
| GET | `/generations/{gid}/logs?stream=validation&tail=200` | Existing log schema |
| GET | `/generations/{gid}/diff` | `text/plain` diff |
| POST | `/generations/{gid}/cancel` | Generation |

Generation requests must explicitly select the scripted provider:

```json
{"parent_id":"11111111-1111-1111-1111-111111111111","prompt":"prioritize notes","name":"Priority notes","provider":"scripted","activate_on_success":false}
```

Omitted/null/other providers fail before creating a generation. No implicit
`PARADOX_AGENT` fallback is allowed for imported-project APIs.

DELETE `/api/repositories/{rid}/trust` requires shell + bearer, returns 204, cancels
in-progress jobs with `error:{"stage":"engine","message":"trust revoked"}`, and
closes the runtime. Durable project data remains. Open/generate/activate/restore
subsequently fail with 403. **The detached-child caveat above currently prevents
claiming complete write revocation.**

## Errors

Repository/project domain errors use `{"detail":{"code":"...","message":"..."}}`.
Existing mirrored timeline/generation error shapes remain unchanged. Invalid JSON
or strict request schema violations use FastAPI's normal 422 validation details.

| HTTP | Codes / meaning |
|---|---|
| 400 | M1 unsafe/invalid input paths |
| 401 | Missing/invalid bearer, including GET and unset-token engines |
| 403 | Origin denial, shell-token denial, `trust_required` |
| 404 | `unknown_repository`, `unknown_project`; unknown timeline/generation uses existing handlers |
| 409 | `already_registered`, `project_exists`, `project_busy` |
| 422 | M1 compatibility failures; `validation_required`, `dependency_unavailable`, `import_rejected`, `provider_unsupported` |
| 503 | M1 `sandbox_unavailable` / registry errors; `execution_sandbox_unavailable` |

## Persistence, isolation and supported scope

Registrations/configurations/trust live in engine-owned `repositories.json`
(0600, atomic replacement; backward-compatible optional trust object).
Projects live in `<state>/projects/<pid>/`, with a 0600 `project.json`, pinned
`import/code`, independent engine DB/lock, workspaces, generations and snapshots.
Restart reloads metadata only; explicit open recovers the engine/jobs/runtime.
Malformed metadata is skipped without disabling the bundled demo. Failed imports
publish no project record and remove staging state.

Committed import uses hardened sandboxed Git `ls-tree` and binary `cat-file
--batch`, never archive/checkout/hooks/filters. Caps are 10,000 files, 1 MiB per
blob and 50 MiB total. Unsafe, non-UTF-8, case/normalization-colliding paths,
symlinks and submodules are rejected. The committed copy is analyzed, validated
against the saved config and dependency-preflighted again before execution.
Dirty files/databases remain untouched and are not imported; `base.dirty` and a
code-only `uncommitted_changes_ignored` warning record that choice.

| Project/layout | Status |
|---|---|
| Narrow FastAPI + engine-installed static dependencies + env-isolated SQLite | Implemented, disposable scripted testing only; overall NO-GO pending P1 |
| Bundled demo | Existing `trusted_local` behavior preserved |
| Missing trust/config/dependencies/sandbox | Fail closed; no imported boot |
| Alternate frameworks, package installation, shell commands, external state | Unsupported |
| Worktrees/submodule checkouts, committed symlinks/submodules, oversized trees | Rejected |
| Detached child processes | Unresolved P1; not supported/release-ready |

The runtime sandbox covers the whole interpreter, not only an inner server command.
Code is read-only; state and private run temporary data are writable. Runtime/test
environments are rebuilt without provider, bearer or shell credentials. Home,
sibling engine data, non-loopback sockets, DNS, Mach services, engine signals and
engine process-environment reads are denied in real HTTP probes. Same-group
children are terminated on shutdown and parent-engine death; temporary runtime
data is excluded from snapshots and cleaned on restart.

The bundled `trusted_local` demo is not promoted to a hostile-code security
boundary by this work. No real Factory calls, pushes, merges or UI modifications
form part of these results.
