# M2-A generation integration: current evidence and remaining gate

Branch: `feat/repository-generation-m2a`.

## Integration order

M1 main `e920df2` is an ancestor of canonical M2 base `7622d59`. The reviewed
M2-A validation slice is `e4cf5bb`. Codex 2 built sandboxed Runtime commit
`3b482de` directly on that slice; Codex 1 rebased onto it, without file copies.
Boot/smoke and forced-unavailable tests were updated in `e1c675a`.

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

This is worker/Runtime integration evidence, not yet project HTTP API evidence.

## Test results

- Full offline suite at exact pre-Runtime slice `e4cf5bb`: **430 passed,
  1 skipped, 1 deselected in 430.00 seconds**.
- Current profile, sandbox validation and real generation/adoption/restart
  selections: **40 passed in 25.28 seconds**.
- A separate durable proof replay of the worker test passed in 10.22 seconds;
  it is not an additional distinct test.
- Nine project HTTP acceptance cases collect successfully but are **explicitly
  skipped** while `engine.projects` is absent. They are not counted as passes
  or E2E evidence. Once that module exists, the skip disappears and the real
  frozen routes must satisfy the assertions.

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

## Exact remaining dependency and verdict

**M2-A worker/validation integration: GO. Full project HTTP M2: NO-GO pending
Codex 2's committed trust/import/projects API and integration regression gate.**

Prepared HTTP cases cover all six frozen recipes, actual source/diff/log/check
and timeline association, independent SQLite futures, cancellation, successful
restart persistence and interrupted-generation recovery. They use only frozen
routes and disposable repositories. They have not been executed against a
projects router yet, so no successful project HTTP flow is claimed.

Mirrored project routes require explicit project open; GET does not implicitly
start imported code. The lanes agreed to reuse frozen `409 project_busy` for a
closed project, rather than introduce a new error code. Durable project metadata
remains readable while closed. Claude was notified of dependency decisions.

Codex 2 must also update its old profile-refusal tests now that sandboxed Runtime
is implemented. The earlier full-suite count does not certify the post-Runtime
tree. Run the final full suite after the committed B API and those test updates
are integrated. No contract or ownership boundary is bypassed to obtain GO.
