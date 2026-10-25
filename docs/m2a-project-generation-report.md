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

## Exact remaining dependency and verdict

**M2-A scripted generation and project HTTP workflow: focused GO at `8e66728`.
Overall M2 integration remains pending the final combined full regression and
integration/security review; this is not merge approval.**

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
