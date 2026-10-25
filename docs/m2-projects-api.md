# M2-B implementation contract and readiness

Implementation branch: `feat/project-runtime-lifecycle`. Frozen interface:
`docs/contracts/m2-projects.md`. M1 registration/validation remains documented in
`docs/m1-repositories-api.md`. No UI or imported-source edits are required.

## Readiness: GO for approved single-process scripted fixtures

The user approved a single supervised imported process on October 24, 2026.
This explicit compatibility/security addendum supersedes the frozen contract's
earlier confined-child allowance, without changing API/adapter signatures.
`process-fork` is kernel-denied; the availability probe verifies fork and
posix_spawn denial and fails closed. No application workers, reloaders, shell
helpers or subprocess-based tests are supported. Threaded FastAPI requests work.
An external trusted supervisor monitors the whole sandboxed application, including
approved-interpreter exec-in-place, and escalates TERM to KILL before returning
from close/switch/revoke. Application code cannot signal that supervisor or obtain
the engine-liveness pipe. See `docs/m2-runtime-lifecycle.md` for the implementation.

The prior detached-child P1 was reproduced on 47fc00b and is historical evidence,
not a passing security gate. Its strict expected failure has been removed in favor
of enforced spawn rejection and adversarial re-exec cleanup tests. Final readiness
requires the new focused and full offline tests. Both are now green, including
independent review. GO is limited to the user-approved disposable-repository,
scripted, single-process scope; no merge or real-user-repository execution is
authorized by this verdict. No known P0/P1 remains in that tested scope.

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
subsequently fail with 403. The single-process supervisor stops the application's
state writer before returning from revocation; this does not add worker support.

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
| Single-process FastAPI + engine-installed static dependencies + env-isolated SQLite | GO for approved disposable/scripted testing |
| Bundled demo | Existing `trusted_local` behavior preserved |
| Missing trust/config/dependencies/sandbox | Fail closed; no imported boot |
| Alternate frameworks, package installation, shell commands, external state | Unsupported |
| Worktrees/submodule checkouts, committed symlinks/submodules, oversized trees | Rejected |
| Workers, reloaders, subprocesses (including test subprocesses) | Kernel-blocked; unsupported, not merely discouraged |

The runtime sandbox covers the whole interpreter, not only an inner server command.
Code is read-only; state and private run temporary data are writable. Runtime/test
environments are rebuilt without provider, bearer or shell credentials. Home,
sibling engine data, non-loopback sockets, DNS, Mach services, engine signals and
engine process-environment reads are denied in real HTTP probes. Spawn/fork are
denied; the supervised process is terminated on shutdown and engine death even
after interpreter replacement or ignored SIGTERM. Temporary runtime
data is excluded from snapshots and cleaned on restart.

The bundled `trusted_local` demo is not promoted to a hostile-code security
boundary by this work. No real Factory calls, pushes, merges or UI modifications
form part of these results.

## Single-process verification

The focused sandbox/runtime/API gate passes 68 tests in 104.76s. This includes
fork/spawn/subprocess/multiprocessing/libc and shell-indirection denial, a
deliberately weakened-profile availability failure, actual uvicorn/pytest/SQLite,
source/Git/database byte and mtime identity, re-exec cleanup on close/switch/revoke,
engine-crash recovery, boot cancellation and health timeout. There are no expected
failures in this gate. A final two-test delta passes in 3.66s, including malformed
configured trust-root handling: one symlink-loop entry is skipped with a code-only
warning while the valid root and bundled demo remain usable. The full offline
regression result will be added after it completes on this security commit.

A subsequent review found that a validation process could call `setsid()` without
creating a child. JobControl now uses the trusted external supervisor and starts
commands as session leaders. The updated helper/runtime/validation gate passes
69 tests in 66.99s; the two launcher tests (including trusted stdin and subprocess
compatibility) pass in 0.45s. Cancellation, timeout and engine-death tests replace
the interpreter, ignore TERM, reject session/group escape, and verify the writer
has stopped. The pre-fix full run was intentionally interrupted at 235 passed / 4
skipped / 1 deselected; **it is not a final full-suite result**. Final regression
must run with both supervision changes integrated.

## Final combined offline gate

Tested source: `3c3a78324cccaf6c948724424e499085e3020a20`, containing both lanes by
history, the single-process restriction (`f8fdf67`), session-leading JobControl
supervision (`291f97b`) and Codex 1's real SQLite/timeline adversarial tests.
The full offline run passes **485 passed, 4 skipped, 1 deselected in 674.97s**.
There are **zero failures and zero expected failures**. The detached trusted test
runner records return code 0 and the exact source SHA; it does not execute
imported code outside the application sandbox.

```text
python -m pytest -q -rsx --junitxml=/tmp/paradox-m2b-final-durable-junit.xml \
  -k 'not test_live_droid_generation_records_a_complete_result'
```

The runner uses an allowlisted environment (PATH, HOME, TMPDIR, LANG, LC_ALL,
`PARADOX_AGENT=scripted`, `PYTHONDONTWRITEBYTECODE=1`), with no provider credentials,
bearer/shell tokens or configured repository roots. Tests install dummy sentinels
where needed. The four skips are exactly:

- `tests/e2e/test_long_generation.py:13`: opt-in four-minute scripted rehearsal.
- `tests/test_droid_sandbox.py:69`: built Node adapter required.
- `tests/test_droid_sandbox.py:177`: built official SDK adapter and CLI required
  for its metadata-only probe.
- `tests/test_droid_sandbox.py:204`: built Node adapter required.

The sole deselection is the paid/live Droid generation test; it was deliberately
excluded. No paid calls were made and existing Factory evidence was not modified.

Codex 1 independently reports **102 distinct focused passes** on the same combined
source: 62 sandbox/launcher/runtime/hostile timeline/real-SQLite tests (88.08s), plus
40 profile/provider/guard/real-validation-worker tests (28.52s). The added source
SQLite fixture is a real database, queried through an immutable read-only URI;
its sentinel row and all source/Git file hashes and mtimes remain unchanged after
generation, activation, managed-state writes and reopen. The hostile outgoing
writer's exact PID is reaped before timeline activation or snapshot restore;
restored state remains free of its marker and the parent's late SQLite write.

Remaining compatibility/security limits are intentional: macOS sandbox-exec only;
no workers, reloaders, subprocess-based tests, dependency installation, external
state or paid providers for imported projects. This is not a VM, a CPU/RAM quota,
or isolation from other unauthenticated localhost services. The bundled
`trusted_local` demo is still not a hostile-code security boundary. Desktop/UI
artifacts and original repositories were not modified, and no push/main merge
forms part of this gate.

## Final adversarial smoke checklist

- Without bearer authentication, repository/project reads fail with 401; foreign
  mutation Origins and missing native shell approval fail with 403.
- Inspect/validate a dirty disposable repository without execution. Source files,
  Git metadata and the real source SQLite sentinel must remain byte/mtime-identical.
- Explicitly trust/import/open; generate only with `scripted`. Check logs/diff,
  parent association, failed/cancelled publication guards and keyless usage.
- Activate a generated future and write isolated SQLite data; switch back and
  restore a snapshot. No late parent write or outgoing writer may cross over.
- Close/reopen and restart the engine: IDs, active future and managed state must
  persist; imported runtimes must remain stopped until explicitly opened.
- Revoke trust during a run: generation stops, runtime/state writer is terminated,
  and execution requires fresh approval. The bundled demo must stay healthy.
- Worker/subprocess fixture import must fail clearly. Fork/spawn, shell/Mach/DNS,
  engine credentials/process information, home reads and source writes stay denied;
  a re-execing TERM-resistant single process must not survive transition or timeout.
