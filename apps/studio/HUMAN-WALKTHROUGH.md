# Prince's Gate A / T-AVP Lite human walkthrough

Recorded human results: PASS for live identification, safe defaults, scripted
generation, inspection without activation, and generation-parent independence.
Architect/Analyze: NOT EVALUATED due to unfamiliar pre-existing history, not UX
failures. Remaining checks below are NOT RUN unless Prince reports otherwise.
Prince authorized a separate clean bundled-demo instance; do not reset existing
state. Scope is the bundled compatible demo, not arbitrary-repository execution.

October 24, 2026. Owner: Prince. Estimate: 20–30 minutes. Every human check
starts NOT RUN. Automated results are not substitutes for these observations.

## Before touching the app

1. Ask Abhi for the desktop artifact or launch instructions, desktop branch/SHA,
   bundled Studio source SHA (or source manifest if uncommitted), build time,
   and exact commands/output for the five reported desktop tests and browser
   rehearsal. The locally verified Studio fixes are uncommitted and therefore
   are not identified by base SHA `10d5689` alone. Establish which UI is bundled.
2. Desktop bundling was authorized by Prince at 13:15 PDT, October 24. No new
   bundling approval is needed. Publication and merging are separate approvals.
3. Use a disposable bundled-demo workspace, not Abhi's shared engine/state or
   an important imported repository. Confirm the engine is keyless, scripted
   is available, Droid is unavailable, and authentication is enabled. Ask Abhi
   to verify the desktop's managed token privately; never paste it in reports.
4. If the native artifact is unavailable, use the current fixed browser Studio
   against a dedicated keyless, token-protected local demo engine. Ask the lead
   to start this environment rather than reusing an unknown running server.
5. Latest fetched main is `5bdecc5b32b74acb065aea5a9c2eecf82cbb01e9`; only
   `docs/m3/demo-day-checklist.md` changed since the tested base. It now requires
   a demo token and warns NOT to use `demo_rehearsal.py --keep-running` for the
   human demo because that launcher drops the token. A scripted default alone
   does not block paid calls: the Factory key must be absent from the engine.
6. Keep browser fallback ready. Native checks remain NOT RUN if inaccessible.
   Do not reinstall dependencies, switch branches, merge, or publish just to
   complete this checklist without coordinating with the lead.

## Execute and record PASS / FAIL / NOT RUN

### 1. First impression and Explore

- Without explanation, identify the live future, selected future, graph,
  composer and portal. Fresh demo: Live is Original, From is Original (live),
  agent is scripted and Keep live is selected.
- Open/close Futures and Inspector; pan, zoom, Fit and Center. Navigate another
  future if present. Selection must not change Live or the portal implementation.
- Record confusing language, hidden controls, overlapping cards and lost focus.

### 2. Generation and A1/A2

- From Original, prompt `Make the feed popular`, leaving Keep live selected.
  Submit once. Observe a ghost, actual progress and accessible logs. Do not
  expect every transient stage to remain visible on a fast run.
- Inspect logs during generation if possible. When complete, inspect the real
  future. The portal and topbar must still show Original as live.
- Inspect the generated child and another future. The next composer parent
  must remain Original unless explicitly changed in From.
- Explicitly choose the generated child as parent. Verify the chosen indicator,
  inspect Original, reload, and check that the explicit source remains chosen.
  Click Use live to return to the backend-confirmed live parent. No activation
  should occur from these operations.
- Do not enable Droid to test its confirmation. Synthetic automated coverage
  already checks paid selection and cancellation without paid requests.

### 3. Inspection

- Open Overview, Diff, Logs, Tests and Snapshots. Read actual changed files,
  validation outcomes, timestamps and base/parent relationships. Empty/unavailable
  evidence must say so, not look like measured success.
- Keep watching Live and the portal: inspecting tabs never activates a future.

### 4. Activation, state isolation and restoration

- While Original is live, save a snapshot and note its ID/time. Create a
  distinctive demo post before generating if testing inherited data is desired;
  alternatively use existing seeded data for ordering verification.
- Explicitly Make live the popular future and confirm the dialog. Verify the
  backend-confirmed Live label and portal change to popular ordering.
- Add a distinctive post only in this generated future. Explicitly Make live
  Original. Verify chronological ordering and that future-only post is absent.
- Return to the generated future and verify its post is still there.
- Separately test Restore on the named Original snapshot; confirm the warning
  and verify Original's saved state and live status. Do not confuse switching
  timelines with restoring a snapshot. Restore intentionally rolls back that
  timeline's later data; use only disposable state.
- Pending lifecycle and Live runtime badges can coexist. The known stale
  post-generation instruction to make an already-live future live is a copy
  issue; verify the backend-confirmed Live indicator instead.

### 5. Recovery and failures

- Submit `slow human refresh check`, then reload once while running. Confirm
  the actual generation remains accessible and no second submission is made.
  Request counts require network evidence; otherwise mark no-duplicate checking
  NOT RUN rather than inferring it from appearance.
- This is a human refresh smoke check, NOT proof of the exact pre-POST-response
  race. That race has deterministic isolated E2E coverage already.
- An unconfirmed attribute match must say ownership is uncertain. Multiple
  candidates must not claim which request is yours. Inspect before cancellation;
  do not cancel a possibly unrelated client's job to clear a message.
- On the disposable demo, `break the app` should produce failed compilation,
  accessible evidence and no activated future. `slow cancellation check` may
  be cancelled explicitly if still running; if it finishes first, record that
  the cancellation check was NOT RUN, not PASS.

### 6. Architect and Analyze

- Open Architect; distinguish observed, documented, inferred and unavailable
  information. Do not mistake the supplied conceptual mockups for implemented
  telemetry, dependency discovery, security checks or framework support.
- Open Analyze; compare Original and the generated future. Confirm each diff
  is relative to its own base, comparisons are understandable and selecting A/B
  does not activate either future.

### 7. Native-only checks

- Resize window wide/narrow/short; open provider/parent dropdowns and confirm
  menus appear on-screen. Test scrolling, dialogs, Escape, Tab/Shift-Tab focus,
  visible focus and keyboard submit. No stray Generate or activation is allowed.
- Quit and reopen the disposable desktop app. Verify timelines persist and
  authentication still works. Observe engine shutdown via Abhi's owned process
  diagnostics; do not terminate engines of uncertain ownership.
- Record platform/build and every native check separately. Browser success
  does not establish native persistence, process lifecycle or token integration.

### 8. Sixty-second judge test

Ask someone unfamiliar with Paradox to watch a 60-second explanation:

“Paradox keeps alternative code and application-state futures together. You
can generate an alternative, inspect real tests and diffs without changing the
live app, then explicitly activate one and return to another.”

Ask: What is live? What does inspection do? Why use this instead of Git
worktrees and an AI agent? Record their answer and time. Do not coach away
confusion or claim conceptual uniqueness has been experimentally proved.
Keep a three-minute scripted walkthrough ready as the longer fallback.

## Consolidated report to Abhi

Copy and fill this in; do not send as completed until checks actually run:

```text
Paradox human walkthrough — October 24, 2026
Tester/platform/time:
Desktop branch/SHA/artifact/build time:
Bundled Studio source reference:
Browser source reference:
Environment: disposable demo; keyless/authenticated confirmed? ____

Local automated Studio: PASS — 79/79 unit, 8/8 isolated E2E,
typecheck/build pass, lint 0 errors/36 warnings. Tested uncommitted
Studio tree on base 10d5689; not proof of another desktop bundle.
Desktop automation: REPORTED 5/5 by Abhi; evidence reviewed? ____
Abhi browser rehearsal: REPORTED PASS; evidence reviewed? ____

Human Explore: NOT RUN
Human generation/A1/A2: NOT RUN
Human inspection: NOT RUN
Human activation/isolation/restore: NOT RUN
Human recovery/failure/cancel: NOT RUN
Human Architect/Analyze: NOT RUN
Native layout/keyboard: NOT RUN
Native persistence/auth/shutdown: NOT RUN
60-second judge comprehension: NOT RUN
Reference fidelity: comparison pending; three references supplied

Findings: severity | steps | expected | actual | evidence | demo impact
P0: unsafe destructive/data-loss/security/cost boundary failure; stop.
P1: core demo/safety workflow broken or no reliable fallback; fix/retest.
P2: nonblocking usability/copy/layout issue; document workaround.

Recommendation: HOLD final readiness until required human checks run.
Then GO / GO WITH LISTED LIMITATIONS / NO-GO, with reason and owner.
Prince stable-baseline approval: PENDING
```

Send one consolidated report, not separate contradictory browser/native verdicts.
Native unavailable can yield browser-only GO with native explicitly unverified;
it cannot yield a native PASS. Final readiness is Prince's human decision.
