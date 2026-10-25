# Verification findings

## Directly checked against recovered primary artifacts

- The saved generation, agent log, 17-record received SDK session, patch and
  generated workspace agree on the generation/session IDs and changed files.
  Public session copies retain all nine tool calls and their results.
- Edit/Create payloads reconstruct the changed ranking and new 75-line test
  file exactly. The two recovered patch copies are byte-identical. Applying
  that patch reproduces the generated workspace and child snapshot source.
- JUnit contains 26 testcase elements, no failures/errors/skips, including eight
  tests in the new module. The original baseline collection/log contains 18.
- Engine evaluation and validation log agree that agent, guard, compile, tests,
  boot and smoke passed. The two file writes have two permission approvals.
- Parent/child ranking SHA-256 values match actual recovered source files.
  Existing baseline files other than ranking remain unchanged in the generated
  workspace. The child snapshot matches the generated workspace.
- The initial timeline listing intentionally leaves the original active
  (`activate_on_success: false`). Later health identifies the child as active;
  parent/child/revisited feed captures support isolation and restoration. These
  are sequential captures, not inconsistent simultaneous active states.
- All 160 entries in the inherited shared-file hash manifest match the recovered
  copies. The ZIP's 164 files include four additional export metadata files.
- All 12 recovered baseline source/document files match publication base commit
  `719ec66f619d8762f53b1a810958cbca612446bf`. Ten are packaged for test replay.
- The offline publication replay passes 26 tests, using the recovered baseline
  plus genuine patch. It does not call Factory or re-execute original engine
  guard, sandbox, boot or adoption checks.

## Documentation corrections and limits

- Commit `70c9aa6` says “7 tests”; primary source, session and JUnit show **8**
  added tests. The correct arithmetic is 18 baseline + 8 added = 26 total.
- That commit cites integration checkpoint `6731c50`. The checkpoint appears in
  session environment metadata, but the Git object is unavailable in this local
  checkout. Exact run-checkpoint identity remains recorded provenance rather
  than an independently inspected commit. Do not substitute today's main for it.
- “Adopted” is supported as creation and subsequent activation of an AI-linked
  timeline. No separate user-confirmation action is evidenced by these captures;
  the pre-activation child listing says `pending`, not `confirmed`.
- SDK version 0.10.0 is saved by the harness and matches the existing adapter's
  pinned dependency. Dependency installation/version was not independently
  recovered from a historical node_modules tree.
- Sandbox enforcement, 42,278 credits, token counts, duration, and one submitted
  generation request are recorded by the run artifacts/harness. There is no
  independent provider billing audit or fresh sandbox verification here.
- The pre-sanitization original-hash claims cannot be checked without those
  private originals. This publication proves consistency of the received
  evidence, not provider-signed authenticity or an independently witnessed run.
- `new_provider_calls_during_export: 0` is the export summary's statement. This
  publication itself invokes no SDK/Factory process and performs no paid runs.

## Publication checks

The publication review inventories/hashes all received files, screens received
and selected files for sensitive material, validates the inherited shared-file
hashes, verifies patch/tool/snapshot consistency, replays all 26 tests offline,
checks the complete staged file set, and runs `git diff --check`. The public
manifest and SHA256SUMS cover the final package. No application implementation,
NASA submission branch, recorded demonstration worktree or main is modified.
The patch-only whitespace attribute preserves three required single-space
unified-diff context markers; all other files use normal whitespace checks.
