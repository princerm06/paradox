# Milestone 3 verification plan, merge order and live-run gate

## 1. Merge order (each step needs user approval)

1. **PR #10, `fix/health-storage-gate`**: a small crash fix with no dependencies.
2. **PR #9, `test/timeline-isolation`**: the SQLite restart fix plus 14 regressions. #10 + #9 together have been tested: 124 passed, 1 skipped.
3. **`fix/validation-hardening`** (Codex 2, P0): must be on `main` before the third paid run.
4. **`feat/droid-verification`** (Codex 1): rebase onto 1–3, rerun all suites, and then do the third paid run *from the rebased commit*.
5. **`feat/demo-rehearsal`** (Codex 2, P1): independent of the rest.
6. **`feat/ui-shell` / `apps/studio`** (frontend): after it's pushed and checked against the contract.

For each step, the integration lead builds the candidate in a separate worktree, runs Node plus the full offline Python suite with `FACTORY_API_KEY` unset, scans the diff for secrets, and confirms no processes are left running. Only then does it recommend the merge.

## 2. Offline verification (every branch)

| Check | Command (from the worktree, own `.venv`) |
|---|---|
| Adapter | `npm --prefix engine/droid_adapter ci --ignore-scripts && npm --prefix engine/droid_adapter run build && npm --prefix engine/droid_adapter test` |
| Full Python | `env -u FACTORY_API_KEY .venv/bin/python -m pytest -q -p no:cacheprovider` |
| Secrets | `git diff origin/main... \| grep -E 'fk-[A-Za-z0-9]{8,}'` must return nothing |
| No orphans | `pgrep -fl <worktree>` must return nothing after the suites finish |
| Scope | changed paths stay inside the owner's lane (`integration-risks.md`) |

## 3. Third paid Droid run: go/no-go gate

### GO only if **all** of these hold

1. **Validation hardening is merged** (or included in the tested candidate). New `conftest.py`, pytest config, `pytest_plugins`, `.pth`/`sitecustomize` and agent bytecode are rejected, with regressions in place.
2. **The SDK configuration is reviewed:**
   - `autonomyLevel: Off` is unchanged.
   - `updateSettings` sends exactly `enabledToolIds: ['Read','Edit','Create']`. No other tool IDs, and a test asserts the exact payload.
   - `Execute`, `Script` and `WaitForScript` are still in `DISABLED_TOOL_IDS`.
   - There is no `AutonomyLevel.Low` anywhere, and no automatic fallback.
3. **The strict check runs after configuration:** the *actual* `listTools()` (no override params) reports `allowed === true` for Read, Edit and Create, and `session.settings` reports `autonomyLevel: off` and `toolExecutionMode: direct_only`. Otherwise the run fails before `session.stream`, with the session closed.
4. **The sandbox has been reviewed and passes offline tests:**
   - Writes are allowed only to the generation's `workspace/code`, the specific `~/.factory` session and log subdirectories, and a dedicated temp dir. **Not** `~/.factory` as a whole, and not the generation's own directory (which holds `agent.log` and `diff.patch`).
   - Paths are canonicalized (`/private/var`).
   - Writes outside, symlink escapes and child-process writes are denied, with tests.
   - If `sandbox-exec` is missing or the profile fails, the run **fails closed**. It never runs unsandboxed.
   - The network is allowed for the live profile only.
5. **Handler audit logging:** every permission decision is logged (outcome, tool, paths), and the verifier reports the counts.
6. **Full offline suites are green** on the exact commit to be run, and the scripted provider still succeeds end to end.
7. **The user explicitly approves the run,** with a new state dir (`.venv/droid-proof-3`).

### NO-GO if any of these is true

Any gate above fails. Any production path can reach Autonomy Low or an unsandboxed spawn. Any secret appears in logs or diffs. The strict check reads hypothetical `listTools` overrides.

## 4. Third paid run: required evidence

From `.venv/droid-proof-3/` (`http-evidence.json`, `generations/<id>/agent.log`, the CLI's `~/.factory/sessions/**/<session>.settings.json`):

| # | Evidence | Pass criterion |
|---|---|---|
| E1 | Preflight log | model = pinned id, `direct_only`, `autonomyLevel off`; Read/Edit/Create `allowed=true` *after* the update |
| E2 | SDK session | non-empty `session_id`; `exit_code` 0; usage and `factory_credits` recorded |
| E3 | Tool calls | at least one Edit or Create `tool_call` in `agent.log` |
| E4 | Permission handler | at least one logged handler decision for each write, all inside `demo_app/`. If writes happened with **zero** decisions, record "handler bypassed; enforcement by guard + sandbox". That isn't a failure of the run, but it **is** a finding the user must accept. |
| E5 | Diff | `changes.files` includes `demo_app/ranking.py` modified plus a new `demo_app/tests/test_*.py`; nothing outside `demo_app/`; existing tests and `AGENTS.md` unchanged |
| E6 | Validation | all checks `passed` (agent, guard, compile, tests, boot, smoke); `tests.failed == 0` |
| E7 | Adoption | `status: succeeded`, `timeline_id` set, timeline `modification: "ai"`, `generation_id` linked |
| E8 | Behaviour | activating the child gives popular ordering; the root stays chronological |
| E9 | Isolation | a child-only write is absent from the root; revisiting the child preserves it; root writes made after generation are absent from the child |
| E10 | Sandbox | no files written outside the allowed paths. Before/after hashes of the repo source tree and the parent snapshot match. No sandbox-denial errors that indicate the CLI was broken. |
| E11 | Cost | credits recorded, and reported to the user |
| E12 | Secrets | `grep -r 'fk-'` over the proof dir returns nothing |

**Successful live generation = E1–E3 and E5–E12 pass.** E4 decides whether we can say "edits are scope-checked by our handler" or only "scope-enforced by the guard and an OS sandbox".

## 5. If the third run fails

Don't retry. Collect E1–E4, diagnose offline, and return to the user with a root cause before any further paid run. The demo uses the scripted provider and shows the recorded real sessions as provenance.
