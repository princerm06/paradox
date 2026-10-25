# Gate A — independent lead verification

Publication update: Prince has now authorized scoped publication and conditional
merge after final-candidate checks, required CI and compatibility gates. Earlier
authorization statements are historical. Final-candidate evidence and actual
PR/merge state are recorded in the external canonical CLOSEOUT.md; this record
does not itself assert that publication or merge has happened.

Human status: five core Explore checks PASS per Prince. Architect/Analyze are
NOT EVALUATED because existing branch history is unfamiliar, not UX failures.
Mockup deviation is provisional nonblocking P2. Remaining human/native checks
and final demo approval are pending.

October 24, 2026. Uncommitted Studio changes on `feat/ui-shell`, base HEAD
`10d56898e8a50f72e92285c8a0471d9c9f7f1227`. No backend or desktop edits,
publishing operations, or paid application generations.

## Verified commands after recovery follow-up

Run from `apps/studio/` with
`export PATH=/Users/princem/.nvm/versions/node/v20.20.2/bin:$PATH`.
The initial pre-follow-up verification attempt used an older Node subprocess
and failed at Vitest startup; exporting PATH corrected the environment.

- `npx tsc -b`: exit 0.
- `npx vitest run`: 79/79 passed in 7 files.
- `npm run build`: exit 0.
- `npx oxlint`: exit 0, 0 errors, 36 warnings, matching reported baseline count.
- `npm run e2e`: 8/8 passed against the isolated scripted engine.
- `git diff --check`: passed.

Raw independent output: `gate-a-evidence/2026-10-24/lead/verification.log`
(ignored by Git). Browser screenshots: `/tmp/paradox-gate-a-lead-final-shots/`.
The E2E run emitted the previously documented ResizeObserver-loop diagnostic;
the eight tests passed. These are automated browser checks, not human rehearsal.

## Review status

A1 provider selection and A2 independent parent passed the first lead review.
The first independent technical review blocked A3 on stale POST callbacks and
ambiguous response failures, and identified later-arriving candidate ambiguity.
Claude implemented follow-up fixes with eleven additional synthetic cases;
the command results above verify that follow-up, not just the earlier 68 tests.
GPT-6 Sol re-review found no remaining release blockers and closed all three
prior findings. A1/A2/A3 pass this scoped technical acceptance, subject to the
coverage limits and remaining Gate A gates below.

The original immediate-refresh bug has real isolated-engine reproduction
evidence in the implementer's ledger. Follow-up failure and late-response cases
are synthetic-only; no expanded real-engine coverage is claimed here.
Attribute matches cannot prove browser ownership without backend request identity.
The UI labels them unconfirmed and permits later ambiguity to be shown.
One nonblocking P2 remains: a sole running unconfirmed match offers Cancel and
Track, but no Dismiss until terminal. Do not cancel another client's possible
job merely to clear this display. This is deferred usability work, not a claim
of fully resolved recovery UX.

## Remaining gates

- Gemini's limited 1440×900 screenshot audit completed without a blocker; see
  `GATE-A-VISUAL-AUDIT.md` for nonblocking findings and lead responsive checks.
- Three concept references now supplied. Gemini's follow-up failed with
  "Connection stalled repeatedly" and produced no comparison verdict. The
  prior missing-reference blocker no longer applies; reference review and
  human approval are pending.
- Full responsive visual sign-off beyond the four root-timeline spot-checks.
- Human demo rehearsal and explicit stable-baseline approval.
- Prince-owned human T-AVP Lite/demo checklist is `HUMAN-WALKTHROUGH.md`.
  M1 onboarding is next as safely feasible, gated on agreed backend/native
  contracts; unrelated roadmap and sponsor work stay deferred.

The historical shutdown checkpoint is unchanged. No commit, push or additional
merge is authorized. Desktop bundling was approved at 13:15 PDT on October 24;
Abhi owns it on his separate branch. This does not authorize publishing/merging.
