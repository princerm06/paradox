# Timeline isolation and backend reliability audit

Audited from `main` commit `0b72c65`, on the separate
`test/timeline-isolation` branch. No Studio or Droid adapter changes.

## Confirmed defect and fix

On restart, `Engine.start` checked for a transition marker and missing application
entrypoint, but not for missing SQLite state. Removing or truncating the live
`workspace/state/app.sqlite3` after a durable checkpoint caused the demo to seed a
fresh database. The engine still reported the previous child timeline and loaded
its code, despite silently losing its saved posts.

Two regression cases reproduced this before the fix. Startup now treats a missing
or zero-byte application database as an incomplete workspace and restores the
active timeline's durable head before starting the runtime. It materializes code
and SQLite together, rather than combining live code with an unrelated database.
The active timeline identity, its saved data, and its parent's separate state
survive restart and subsequent traversal. HTTP API contracts are unchanged.

## New regression coverage

`tests/test_isolation_reliability.py` exercises real SQLite files, real application
runtime subprocesses, HTTP proxy requests, and the actual scripted generation
validation pipeline. Event barriers pause adoption deterministically; they do not
replace code, database, guard, compile, tests, boot, or smoke validation.

| Scenario | Verified invariant |
| --- | --- |
| Missing or zero-byte live SQLite on restart | Restore saved active code/data, never silently reseed |
| User switches to a sibling while generation is validating | Default adoption leaves that sibling active and preserves its writes |
| Parent changes after the generation captures its base | Generated future gets the captured data, not later parent/sibling writes |
| Parent snapshot hashing before/after generation | Durable base code and SQLite remain byte-for-byte unchanged |
| Pending parent declined before adoption | No generated timeline; original preview remains active and healthy |
| Cancellation after validation, with/without requested activation | Terminal cancellation publishes no timeline, changes no live data, leaves no transition marker |
| Generated child confirmed while inactive | Confirmation does not activate or merge it |
| Child checkpoint and restore while parent is active | Child code/data restore and activation agree; parent data remain unchanged |
| Preview under a reverse-proxy root path | Active flags, health, ranking, redirects, and `no-store` responses agree |
| Active descendant declined after its ancestor is archived | Return to nearest non-declined ancestor without leaking private data |
| Compile, test, or guard failure from an inactive parent | No adoption or automatic activation; active sibling and parent snapshot remain intact |
| Explicit auto-activation from an inactive parent | Outgoing sibling's uncheckpointed live writes are saved and survive a return visit |

The 12 new cases complement existing tests for runtime crash/restart, sibling and
grandchild isolation, invalid snapshot ownership, snapshot restoration, lifecycle
conflicts, same-port reuse, cancellation during activation, rollback failure, and
generation recovery after engine termination. No existing features were rebuilt.

## Validation

Use the audit worktree's own Python environment:

```sh
.venv/bin/python -m pytest tests/test_engine.py tests/test_generations.py -q
.venv/bin/python -m pytest tests/test_isolation_reliability.py -q
.venv/bin/python -m pytest -q
```

Before the fix, the two new database-loss cases failed with missing saved posts.
After the fix, all 12 targeted cases pass. The original 39 core engine/generation
tests passed before modifications. Final full-suite results are reported with the
commit handoff rather than hard-coded here.

## Remaining risks and limits

- Recovery restores the latest durable head. Writes that were never checkpointed
  cannot be reconstructed from a deleted/truncated live database.
- The new recovery check covers absent and zero-byte SQLite files, not arbitrary
  nonempty database corruption or loss of snapshot files themselves. Preserve
  external backups; this local prototype is not a disaster-recovery service.
- A generated-code workspace is not an OS sandbox. Validation runs trusted code
  as the current user with filesystem and network access. Source/adoption guards
  do not contain a malicious program's execution.
- Tests cover scripted generation without credentials. They do not establish live
  Factory/Droid availability, model quality, or malicious-agent containment.
- This is a single-engine-worker design. The process lock and in-process gate
  are not a multi-host or multi-worker execution architecture.
- Event-barrier and existing crash tests exercise specific concurrency/recovery
  boundaries, not every possible power-loss or filesystem failure point.
