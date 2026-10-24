# Milestone 3 integration risk report

As of 2026-10-24, after the third live run succeeded. `main` = `0b72c65`. Owners: Codex 1 owns the Droid adapter and sandbox; Codex 2 owns validation, engine reliability and the demo rehearsal; Claude owns integration and docs; the frontend teammate owns `apps/studio/`.

## Branches in flight

| PR | Branch @ SHA | Owner | Review state |
|---|---|---|---|
| #10 | `fix/health-storage-gate` @ `6ea89fb` | preserved by Claude | 110 passed + 1 skipped; fixes a reproduced segfault |
| #9 | `test/timeline-isolation` @ `8b8048d` | Codex 2 | 123 passed + 1 skipped |
| #12 | `fix/validation-hardening` @ `2d28323` | Codex 2 | reviewed (the `os._exit(0)` hole is closed) |
| #13 | `feat/droid-verification` @ `f14a0da` | Codex 1 | security-reviewed: 154 passed + 1 skipped, Node 48; **live run 3 succeeded** |
| #14 | `feat/demo-rehearsal` @ `35423f3` | Codex 2 | script run: 7/7 PASS |
| #15 | `test/long-generation-reliability` @ `9d12f72` | Codex 2 | opt-in 4-minute test passed (Codex 2) |
| #11 | `chore/m3-integration-docs` | Claude | docs only |
| — | `feat/ui-shell` (`apps/studio`, `a37f288`) | frontend | **not pushed** |

The tested combination `integration/m3` @ `6731c50` (#10 + #9 + #12 + #13) gave Node 48 and Python 216 + 1 skipped, and produced the successful live run. Replaying the full merge order in §1 of `verification-plan.md` gives engine/demo_app/test files identical to `integration/m3`. The only differences are the additive #14, #15 and #11 files. #12 and #13 both touch `engine/generations.py`, in different blocks, and they auto-merge cleanly.

## Risks (highest first)

| # | Risk | Impact | Status / mitigation |
|---|---|---|---|
| R1 | ~~No successful live Droid generation.~~ **Resolved:** run 3 (`1c98d768`, 42,278 credits) succeeded and was adopted. Runs 1 and 2 had failed on tool exposure (138,785 credits). | — | Code is in PRs #12/#13. Each live run costs about 42k credits; plan at most one on stage. |
| R2 | ~~Permission handler unproven.~~ **Resolved:** in run 3 the handler was called twice and approved both writes (Edit, Create). | — | The guard and the sandbox remain independent layers. |
| R3 | **The tool-enable field is untyped in the TypeScript SDK 0.10.0** (`enabledToolIds` via `updateSettings`). | Could break silently in a future SDK or CLI version | It's documented first-party in the Python SDK (`enabled_tools`). The strict post-configuration `listTools` check fails closed before any model turn. Pin the SDK and CLI versions for the demo. |
| R4 | **Sandbox scope.** If `~/.factory` is writable as a whole, Droid could plant settings, hooks or droids that run *outside* the sandbox later. `/var` is a symlink to `/private/var`. `sandbox-exec` is deprecated. | Persistent escape; profile mismatches | Review gate: only the session and log subdirectories, real paths only, fail closed if the sandbox can't start. |
| R5 | **Generated code can influence test results** (conftest/config/bytecode, `os._exit(0)`, collection hiding) | "Tests passed" could be faked | **Mitigated in PR #12:** guard rejections, `--noconftest` plus a trusted base fixture, strict JUnit checks, and an executed ≥ base-count floor. Residual: forging a plausible report and still exiting 0. Boot and smoke stay independent. |
| R6 | **The studio isn't pushed and hasn't been reviewed** (`apps/studio`, `a37f288` is local only). Generations take minutes, not seconds. The default provider becomes `droid` (paid) whenever a key is present. | Demo stalls; accidental spend | The studio must send `provider` explicitly and tolerate runs of 5+ minutes. Run the demo engine with `PARADOX_AGENT=scripted` except for the planned live run. |
| R7 | **Health endpoint crash** (`main`): concurrent health and timeline requests segfault the engine | Engine dies mid-demo | Fixed in PR #10; 3/3 reproductions crash before the fix, 0/3 after |
| R8 | **SQLite data loss on restart** if the live DB is missing or empty (`main`) | A timeline silently reseeds | Fixed in PR #9 |
| R9 | **Uncommitted changes in `~/paradox`**: the health fix (identical to PR #10) and `apps/prototype/tests/` (owner unconfirmed) | Confusing state; accidental commits | Preserved. They become a no-op after #10 merges. The frontend teammate should claim `apps/prototype/tests/`. |
| R10 | **npm advisories** in the SDK's transitive dependencies (1 moderate, 2 high: uuid/zod) | Questions from judges | Local tool, not network-exposed. Documented in `VERIFICATION.md`. |
| R11 | **The engine has no auth by default.** A scratch workspace is not a sandbox. Droid can read your files and has network access during live runs. | Local-only threat model | Keep the engine on loopback. `PARADOX_TOKEN` exists if you need to share it. This is documented in the README's security scope. |
