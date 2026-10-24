# Milestone 3 integration risk report

As of 2026-10-24. `main` = `0b72c65`. Owners: Codex 1 owns the Droid adapter and sandbox; Codex 2 owns validation, engine reliability and the demo rehearsal; Claude owns integration and docs; the frontend teammate owns `apps/studio/`.

## Branches in flight

| Branch | Owner | State | Overlaps |
|---|---|---|---|
| `fix/health-storage-gate` (PR #10) | preserved by Claude | reviewed: 110 passed, 1 skipped | `engine/api.py`, `tests/test_engine.py` |
| `test/timeline-isolation` (PR #9) | Codex 2 | reviewed: 123 passed, 1 skipped | `engine/service.py` (+3/−1) |
| #10 + #9 combined | — | **124 passed, 1 skipped**, Node 17/17 | merge is clean |
| `fix/validation-hardening` | Codex 2 | in progress | `engine/validation.py`, the validation part of `engine/generations.py` |
| `feat/droid-verification` | Codex 1 | `e7b94be` reviewed; sandbox wiring in progress | `engine/droid_adapter/**`, `providers.py`, `jobs.py`, the agent-stage block of `generations.py` |
| `feat/demo-rehearsal` | Codex 2 | queued | `scripts/`, `docs/` |
| `feat/ui-shell` (`apps/studio`, `a37f288`) | frontend | **not pushed** | `apps/**` |

**Overlap to watch:** both `fix/validation-hardening` and `feat/droid-verification` edit `engine/generations.py`, in different blocks (validation vs. agent stage). Expect a textual conflict to be possible but small. Merge validation hardening first and rebase the Droid branch onto it.

## Risks (highest first)

| # | Risk | Impact | Status / mitigation |
|---|---|---|---|
| R1 | **No successful live Droid generation yet.** Two paid runs failed on tool exposure (Script disabled under `script_only`; Edit/Create hidden under Autonomy Off). Together they cost 138,785 credits. | The headline sponsor feature is unproven | Codex 1 is wiring Off + explicitly enabled Read/Edit/Create + a write sandbox. The third run is gated on `verification-plan.md` §3. The scripted fallback is ready. |
| R2 | **Permission-handler enforcement is unproven** under the new configuration. The CLI source suggests Off still routes confirmations, but no live tool call has been observed. | Edit-scope enforcement may rest only on the guard and the sandbox | The guard independently rejects any change outside `demo_app/` in `workspace/code` (`validation.py`). The sandbox blocks writes outside the future. The third run must log handler decisions. |
| R3 | **The tool-enable field is untyped in the TypeScript SDK 0.10.0** (`enabledToolIds` via `updateSettings`). | Could break silently in a future SDK or CLI version | It's documented first-party in the Python SDK (`enabled_tools`). The strict post-configuration `listTools` check fails closed before any model turn. Pin the SDK and CLI versions for the demo. |
| R4 | **Sandbox scope.** If `~/.factory` is writable as a whole, Droid could plant settings, hooks or droids that run *outside* the sandbox later. `/var` is a symlink to `/private/var`. `sandbox-exec` is deprecated. | Persistent escape; profile mismatches | Review gate: only the session and log subdirectories, real paths only, fail closed if the sandbox can't start. |
| R5 | **Generated code can influence test results.** Examples: a new `conftest.py` or pytest config, planted bytecode, or import-time monkeypatching in a new test module. | "Tests passed" could be faked | Codex 2 P0. Boot and HTTP smoke checks run in a separate process on fresh parent state and stay independent. The import-time monkeypatch risk is documented as residual. |
| R6 | **The studio hasn't been reviewed against real Droid.** Generations take minutes, not seconds. The default provider becomes `droid` (paid) whenever a key is present. | Demo stalls; accidental spend | The studio must send `provider` explicitly and tolerate runs of 5+ minutes. Run the demo engine with `PARADOX_AGENT=scripted` except for the planned live run. |
| R7 | **Health endpoint crash** (`main`): concurrent health and timeline requests segfault the engine | Engine dies mid-demo | Fixed in PR #10; 3/3 reproductions crash before the fix, 0/3 after |
| R8 | **SQLite data loss on restart** if the live DB is missing or empty (`main`) | A timeline silently reseeds | Fixed in PR #9 |
| R9 | **Uncommitted changes in `~/paradox`**: the health fix (identical to PR #10) and `apps/prototype/tests/` (owner unconfirmed) | Confusing state; accidental commits | Preserved. They become a no-op after #10 merges. The frontend teammate should claim `apps/prototype/tests/`. |
| R10 | **npm advisories** in the SDK's transitive dependencies (1 moderate, 2 high: uuid/zod) | Questions from judges | Local tool, not network-exposed. Documented in `VERIFICATION.md`. |
| R11 | **The engine has no auth by default.** A scratch workspace is not a sandbox. Droid can read your files and has network access during live runs. | Local-only threat model | Keep the engine on loopback. `PARADOX_TOKEN` exists if you need to share it. This is documented in the README's security scope. |
