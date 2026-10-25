# M2-A step 3: sandboxed validation integration

## Runtime integration follow-up

The original validation slice below was accepted at `e4cf5bb`. A subsequent full
offline run at that exact commit passed **430 tests, 1 skipped, 1 deselected** in
430.00 seconds, with all four credential variables unset and
`PARADOX_AGENT=scripted`.

Codex 2 then committed sandboxed Runtime wiring at `3b482de`, directly on
`e4cf5bb`. This branch consumes that commit by ancestry. The obsolete boot-refusal
test is replaced with real sandboxed boot/smoke and a forced sandbox-unavailable
case that verifies failure before Popen. The real runtime also verifies sentinel
credential absence, unchanged generated source and unchanged baseline state.
Profile plus sandbox validation tests now pass **39 tests in 15.66 seconds**.

The full project HTTP API, trust/import lifecycle and mirrored routes remain a
separate Codex 2 dependency. The original slice's NO-GO statement below is
historical; runtime boot is now tested, but full HTTP E2E is not yet claimed.

## Scope and ancestry

Branch: `feat/repository-generation-m2a`.

This branch builds on Codex 2's canonical `integration/m2-base` at `7622d59`,
which rebases the reviewed sandbox (`1082e12`) onto main `e920df2`.
The source is inherited through commits, not copied from another worktree.
Credential fixes, launcher isolation, adapter preflight and sandbox rules are
present in that ancestry. Codex 1 changes no Runtime, adapter, project lifecycle,
repository API, generation constructor or adoption implementation.

Step-1 commits after rebase:

- `4b5709d`: profile-aware generation, guard and providers.
- `273d4ca`: isolated validator bootstrap and bounded pytest discovery.
- `04cbb78`: JSON shadow regression.

Earlier full-suite evidence remains attributed to the original `8468f2c`
(355 passed, 1 skipped, 1 deselected); it is not a full-suite result for this
new integration base.

## Actual validation evidence

All new cases build disposable Git repositories with `build_notes_repo`, copy
their source into a private generation workspace, and select provider `scripted`
explicitly. Static adapter preflight runs against the private baseline copy.
No real user repository, external agent, Factory SDK call or credential is used.

The prompt `prioritize notes` produces a real private-copy diff:

```diff
-ORDERING = "chronological"
+ORDERING = "priority"
-    return sorted(notes, key=lambda note: note["id"], reverse=True)
+    return sorted(notes, key=lambda note: (note["priority"], note["id"]), reverse=True)
```

It also adds `tests/test_generated_priority.py`, which exercises `/api/notes`
through the in-process ASGI client and checks priorities `[8, 1]`.

Observed outcomes under the real macOS sandbox:

| Case | Result |
| --- | --- |
| Feature edit | Guard and compile pass; baseline collects 4; tests report 5 passed |
| Broken Python recipe | Compilation fails with SyntaxError |
| Failing test recipe | JUnit reports 4 passed and 1 failed; acceptance rejects it |
| Delete protected test | Guard rejects before executing the changed project |
| Change requirements | Guard rejects before executing the changed project |
| Tool shadowing | Root pytest.py, compileall.py and json.py cannot replace tooling or fake success |
| Credential sentinels | Compile, collection and pytest environments omit all four sentinels; a real child test also verifies absence |
| Pre-cancelled validation | Raises cancellation without starting a job process |
| Imported boot | Explicitly refused by the current Runtime; no boot/smoke success recorded |

Every case verifies source working files and all `.git` file bytes and mtimes
remain unchanged. Compilation and tests leave generated source unchanged, create
no `.pyc` under code, and do not mutate baseline state. Test state, reports and
bytecode use private sandbox-writable paths. Provider usage records have null
Factory-credit usage rather than fabricated paid execution.

The combined profile and real sandbox suite passes **38 tests in 15.95 seconds**:

```sh
env -u FACTORY_API_KEY -u PARADOX_TOKEN -u PARADOX_SHELL_TOKEN -u ANTHROPIC_API_KEY \
  .venv/bin/python -m pytest tests/test_project_generation_validation.py \
    tests/test_project_generation_profiles.py -q
```

The sandbox denies Mach brokers and DNS. Network health probes must use numeric
`127.0.0.1`; these application tests use an in-process TestClient, not DNS.

Additional regression runs on this tree, with the same credential variables
unset:

- `tests/test_generations.py tests/test_droid_provider.py tests/test_runtime_environment.py tests/test_projects_profile.py`: **69 passed in 66.50 seconds**.
- `tests/test_validation_hardening.py`: **47 passed in 27.24 seconds**.

Together these disjoint selections cover 154 passing tests. They are focused
integration/regression results, not a full-suite count. Codex 2 is separately
running the full suite on the canonical base; that result must be attributed to
its exact base commit, not this branch.

## Integration verdict and remaining gates

**GO for the compile/collection/test integration slice. NO-GO for claiming full
project generation end to end at this commit.**

Codex 2's separately owned sandboxed Runtime and project lifecycle are not wired
in this base. Imported boot/smoke is still refused, intentionally. Consequently
this report does not claim successful adoption, preview, timeline state switching,
trust revocation or project HTTP API evidence. Those acceptance cases must run
against the committed, reviewed B integration, once separately authorized.

No API or shared interface was changed. Claude and Codex 2 receive commit SHAs,
test results and this dependency limitation. No push, merge, frontend change,
paid call or automatic provider fallback is performed.

Validation runs project tests in-process with pytest, so hostile code could forge
its own report. Validation is evidence, not the security boundary. OS sandbox
enforcement remains the security boundary; no fallback to unsandboxed execution
is enabled.
