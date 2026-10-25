# M2-A generation integration: HTTP evidence and regression gate

Branch: `feat/repository-generation-m2a`.

## Integration order

M1 main `e920df2` is an ancestor of canonical M2 base `7622d59`. The reviewed
M2-A validation slice is `e4cf5bb`. Codex 2 built sandboxed Runtime commit
`3b482de` directly on that slice; Codex 1 rebased onto it, without file copies.
Boot/smoke and forced-unavailable tests were updated in `e1c675a`.
Worker and HTTP acceptance tests were committed in `3a804975`. Codex 2 then
built the trust/import/projects API in `8e66728` on those commits. Codex 1
fast-forwarded to that exact commit and independently ran the real HTTP cases.
Both lanes are integrated by history, not copied source.

Codex 2 retains ownership of Runtime, storage, import, trust, projects/router,
generation constructor and adoption hooks. Codex 1 owns worker orchestration,
validation, providers, project fixtures and generation acceptance tests.
Neither lane modifies Studio or desktop artifacts.

## Real successful generation

A disposable standalone FastAPI/SQLite Git repository was created using the
frozen `build_notes_repo` fixture. Its private copied baseline passed static
adapter preflight. A real sandboxed Engine and Generations worker then processed
the explicit provider `scripted` and prompt `prioritize notes`.

Persisted proof replay:

```json
{
  "id": "052e27d5-6660-4b9b-b557-7b035e0cf3a5",
  "parent_id": "5f43cd33-a9a0-4017-8e1c-16b603e0846c",
  "timeline_id": "2b55950e-5700-4a30-9d7e-fbaefc244978",
  "provider": "scripted",
  "status": "succeeded",
  "tests": {"passed": 5, "failed": 0, "errors": 0},
  "error": null
}
```

All six recorded checks passed: agent, guard, compile, tests, boot and smoke.
The baseline collected four tests. The feature changes `notes_app/ranking.py`
from chronological order to priority-descending order and adds
`tests/test_generated_priority.py`. The real diff and validation logs were read
back through Generations. The timeline's parent and generation association
matched the persisted generation record. Factory-credit usage is null: this is
not a paid run.

The active parent stayed unchanged after non-activating generation. A later
parent-only SQLite write was absent from the generated future. A child-only
write was absent from the parent, survived switching away and back, and remained
after closing and restarting the engine. The successful generation record and
active future association survived restart unchanged.

Every test compares all source working files and `.git` file hashes and mtimes
before and after. No source repository writes are permitted. Compilation,
pytest and validation boot run inside the reviewed OS sandbox; runtime HTTP
probes use `127.0.0.1`. No imported runtime is started unsandboxed.

The UUIDs above identify the earlier worker/Runtime replay. The independent
HTTP acceptance run below created separate disposable projects and UUIDs;
those worker UUIDs must not be presented as HTTP-run identifiers.

## Independent HTTP integration evidence

At exact committed source `8e66728`, all nine HTTP cases passed without skips.
The exercised flow is register → inspect → validate → trust → import → explicit
open → scripted generation → validation → adopt → activate → close/restart/open.
The source repository, including every `.git` file's hash and modification time,
was compared before and after each case and remained unchanged.

The successful HTTP generation exposed the real changed-file list and unified
diff for `notes_app/ranking.py` and `tests/test_generated_priority.py`, agent
and validation logs, all six passing checks, and five passing tests. Its future
had the expected parent and generation IDs. Non-activating generation preserved
the current parent. Parent-only and child-only SQLite writes remained isolated
when switching timelines. Factory credits were null, not fabricated zero usage.

Four failure cases preserved inspectable failed records, diffs and logs without
publishing a timeline: compile failure, a real failing test (four pass/one fail),
protected existing-test deletion and dependency-manifest modification. The slow
recipe both succeeded normally and cancelled without publishing a future.
Successful records survived restart. Shutdown during generation recovered as a
failed record at stage `engine`, with no orphan future. Restart left imported
runtimes stopped until an explicit open.

The acceptance test drives these existing routes (IDs are taken from responses):

```text
POST /api/repositories                         {"path":"<disposable Git root>"}
POST /api/repositories/{rid}/inspect           {}
POST /api/repositories/{rid}/validate          {}
POST /api/repositories/{rid}/trust             {}
POST /api/projects                            {"repository_id":"<rid>"}
POST /api/projects/{pid}/open                  {}
GET  /api/projects/{pid}/timelines
POST /api/projects/{pid}/generations           {"parent_id":"<timeline>","prompt":"prioritize notes","provider":"scripted","activate_on_success":false}
GET  /api/projects/{pid}/generations/{gid}
GET  /api/projects/{pid}/generations/{gid}/diff
GET  /api/projects/{pid}/generations/{gid}/logs?stream=validation
```

HTTP fixtures use dummy bearer/shell tokens for the existing authorization
boundary. No credentials or real source paths are needed in the report.

## Test results

- Full offline suite at exact pre-Runtime slice `e4cf5bb`: **430 passed,
  1 skipped, 1 deselected in 430.00 seconds**.
- Independent profile, sandbox validation and real worker/adoption/restart
  selections at `8e66728`: **40 passed in 26.95 seconds**.
- A separate durable proof replay of the worker test passed in 10.22 seconds;
  it is not an additional distinct test.
- Independent project HTTP acceptance at `8e66728`: **9 passed in 76.01
  seconds**, zero skips. These are actual API and sandboxed-runtime tests,
  not mocks. B's earlier independent run passed the same nine cases in 72.53
  seconds; that is a replay, not nine additional distinct tests.
- A combined full offline regression run is owned by Codex 2. Its final result
  and exact source revision remain a separate integration gate; the historical
  `e4cf5bb` full-suite count does not certify the post-Runtime/API tree.

All runs unset `FACTORY_API_KEY`, `PARADOX_TOKEN`, `PARADOX_SHELL_TOKEN` and
`ANTHROPIC_API_KEY` at invocation. Individual security tests use dummy sentinels;
HTTP fixtures use dummy operator tokens. Provider selection is scripted. No real
Factory credential, SDK model turn, real user repository, push or merge is used.

Reproduce the real worker proof (the basetemp directory must be disposable;
pytest replaces it):

```sh
env -u FACTORY_API_KEY -u PARADOX_TOKEN -u PARADOX_SHELL_TOKEN -u ANTHROPIC_API_KEY \
  PARADOX_AGENT=scripted .venv/bin/python -m pytest \
  tests/test_project_generation_validation.py -k worker -q \
  --basetemp=.venv/m2a-worker-proof
```

The resulting private code, state, snapshots, logs, diff and engine database are
under that ignored proof directory. A rerun creates new UUIDs; the values above
identify the recorded replay, not fixed fixture identifiers.

Reproduce independent HTTP acceptance and focused generation validation:

```sh
env -u FACTORY_API_KEY -u PARADOX_TOKEN -u PARADOX_SHELL_TOKEN -u ANTHROPIC_API_KEY \
  PARADOX_AGENT=scripted .venv/bin/python -m pytest -q \
  tests/test_project_generation_http.py
env -u FACTORY_API_KEY -u PARADOX_TOKEN -u PARADOX_SHELL_TOKEN -u ANTHROPIC_API_KEY \
  PARADOX_AGENT=scripted .venv/bin/python -m pytest -q \
  tests/test_project_generation_profiles.py tests/test_project_generation_validation.py
```

Local ignored logs: `.venv/m2a-http-integrated.log` and
`.venv/m2a-integrated-focused.log`. These tests require macOS and the reviewed
working `sandbox-exec` helper. Numeric `127.0.0.1` is required because the sandbox
denies DNS/Mach brokers. Unavailable sandboxing fails closed before runtime spawn.

## Independent single-process Runtime review

The user subsequently approved narrowing imported execution to a single
supervised process. This explicitly supersedes the original confined-child
compatibility requirement; apps/tests needing workers or subprocesses are
unsupported. It does not restrict trusted engine or agent orchestration.

Codex 2 committed the implementation as `f8fdf67`, consumed here by history.
The helper denies process creation and verifies enforcement with real fork and
posix_spawn probes before permitting execution. A trusted external `python -I`
supervisor launches the app as a separate session leader, retains the engine
liveness pipe outside application control, and terminates/reaps the app with
TERM followed by KILL if necessary. In-place exec does not remove supervision.

Independent exact-`f8fdf67` selection:
`tests/test_exec_sandbox.py`, `tests/test_projects_runtime.py`,
`tests/test_projects_api.py`, and the original nine HTTP acceptance cases:
**77 passed in 199.01 seconds**, no expected failures. This includes fork,
spawn, indirect process creation, fail-closed enforcement tampering, real
re-exec cleanup on close/project-switch/revoke, crash, timeout and cancellation.
Local log: `.venv/m2a-single-process-review.log`.

Additional A-owned HTTP coverage creates an actual untracked source
`notes.sqlite3` containing a sentinel row before fingerprinting the repository.
Every HTTP case compares all source and `.git` file hashes/mtimes and queries
that sentinel using SQLite's immutable read-only mode after completion. A new
explicit case generates/activates a future, writes managed state, restarts and
reopens, and verifies the original database and all source files are unchanged.
The initial ten-case run passed in 100.30 seconds.

Two additional hostile cases perform a real scripted generation, then replace
the outgoing parent application with a SIGTERM-ignoring state writer after
proving a detached-spawn attempt was denied. The real timeline-activation and
snapshot-restore routes must reap the outgoing PID, restore clean target state
without the parent's late SQLite write, and prevent writer-marker recreation.
Both passed in 28.45 seconds. These are timeline transitions, not merely
switching between projects. These repeated selections are not additive distinct
test totals.

Final entire HTTP module on the additive test source: **12 passed in 123.52
seconds**, no skips or expected failures. This includes the real SQLite
sentinel in every fixture plus the two hostile timeline transitions. Source
production remains exact `f8fdf67`; only this report and the A-owned HTTP tests
changed. Log: `.venv/m2a-final-http-security-delta.log`. The new tests do not
cover the validation-job `setsid()` finding described below.

## Independent validation-supervisor review

B committed the validation-job correction as `291f97b`. Only the A-owned
additive test/report commit was rebased onto it, producing combined source
`3c3a783`; B's reviewed commits were not rewritten or copied. JobControl now
uses the same isolated trusted stdlib supervisor as Runtime. The command is a
session leader and does not inherit the engine-death descriptor. The trusted
supervisor remains outside sandboxed application control, enforces TERM/KILL
cleanup, and reaps the command after cancellation, timeout or engine death.
Trusted jobs retain stdin and subprocess support; the new process-creation
restriction applies to wrapped imported execution, not the engine or agents.

Independent exact-`3c3a783` selection: sandbox, isolated-launcher, Runtime,
hostile timeline activation/restore, and actual source-SQLite generation/reopen:
**62 passed in 88.08 seconds**, zero expected failures. This includes the
re-exec/ignore-TERM writer's failed setsid/setpgid escape attempts, stable state
after cancellation and timeout, and real engine-death cleanup. The trusted
stdin/subprocess positive control also passed. Log:
`.venv/m2a-job-supervision-review.log`. No new independent security objection
was found in this review; it does not constitute a proof against all possible
hostile native code or replace the final combined regression gate.

The separate profile/provider/guard and real validation/worker selection at the
same `3c3a783` also passed: **40 passed in 28.52 seconds**. It covers baseline
collection, compile/test/guard failures, protected manifests/tests, tooling
shadowing, credential absence, cancellation, real boot/smoke and durable future
adoption/state restoration. Together these two non-overlapping selections give
**102 independently passing focused tests** on the combined committed source.
Log: `.venv/m2a-final-generation-validation.log`. The latter invocation also
explicitly unset `OPENAI_API_KEY` and the optional long-generation test flag.

## Exact remaining dependency and verdict

**M2-A workflow and single-process supervision: focused GO at `3c3a783`.
Both known lifecycle findings have committed corrections and independently
passing focused regressions. Overall M2 completion awaits B's final combined
full offline result at `3c3a783`. This is not merge or distribution approval.**

Codex 2 reported a separate disposable adversarial reproduction on `8e66728`:
an imported app launched the approved Python interpreter with
`start_new_session=True`. That child survived `Engine.close()` because it left
the runtime's process group. It remained sandboxed, but retained the ability to
write the old future's permitted state after timeline switching or trust
revocation. The probe explicitly killed its detached process group afterward.
This finding is reported by B; it was not independently rerun by A.

The approved single-process policy and independently tested Runtime supervision
address that original Runtime path. B then reported a distinct validation-job
gap: a sandboxed validation process can call `setsid()` without creating a child,
escape the trusted job launcher's process group, and survive group-only
cancellation/timeout. The Runtime app was already a session leader; the earlier
JobControl child was not. B's `291f97b` internal supervision correction and the
independent review above address that second finding without changing A
interfaces. Full-suite counts on `f8fdf67` predate that correction and must not
be used as its final verification evidence.

Mirrored project routes require explicit project open; GET does not implicitly
start imported code. The lanes agreed to reuse frozen `409 project_busy` for a
closed project, rather than introduce a new error code. Durable project metadata
remains readable while closed. Claude was notified of dependency decisions.

Codex 2 updated its old profile-refusal tests in the committed API slice. No
contract or ownership boundary was bypassed. Supported execution remains the
single frozen FastAPI/SQLite adapter with preinstalled compatible dependencies,
committed HEAD import, explicit trust and a scripted provider. This is not
arbitrary framework support. Imported Droid execution remains disabled; future
integration must preserve the same isolated profile/workspace/provider boundary
and receive separate approval. No paid-call verification is implied.
