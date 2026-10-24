# Paradox studio handoff

## Publication closeout update — October 24, 2026

Prince authorized scoped Gate A commit/push/PR and conditional merge after all
merge gates pass. Publication is prepared in an isolated checkout on latest
main; the original dirty `feat/ui-shell` checkout and running human session are
preserved. Earlier uncommitted-state and authorization notes below are historical.

Prince reports five human PASS results: live identification, safe defaults,
scripted generation, inspection without activation, and parent independence.
Architect/Analyze are NOT EVALUATED due to unfamiliar existing branch history,
not UX failures. Crowded history is a testing-context limitation, not a confirmed
product defect. Mockup deviation is provisional P2 and nonblocking; no redesign.
Activation/restoration, state isolation, recovery and native verification remain
pending. Technical integration is not final human demo approval.

M1 frozen v1 contract is available at `docs/contracts/m1-projects.md` on
`origin/docs/m1-projects-contract` (6278e785). It is not integrated here. Repository
GETs require bearer authentication; the existing GET client behavior must be
addressed deliberately in the separate M1 change. No M1 code is in this PR.

Canonical publication status and clean-demo handoff live outside the watched
checkout: `/Users/princem/paradox-closeout/2026-10-24-parallel/CLOSEOUT.md`.

## Superseding coordination update — October 24, 2026

- **Desktop bundling APPROVED:** Prince approved Abhi bundling production Studio at 13:15 PDT, confined to Abhi's separate `apps/desktop/` branch. Do not seek that approval again. No publication, merge, paid generation or uncoordinated Studio edit is authorized by it.
- Abhi's 14:23 PDT email reports a working native app, 5/5 desktop tests and a passing browser rehearsal. These are reported, not independently verified here; confirm which Studio source was bundled, since our fixes remain uncommitted.
- Prince owns the human T-AVP Lite/demo walkthrough and consolidated report to Abhi: `HUMAN-WALKTHROUGH.md`. All human/native checks currently NOT RUN by Prince in this thread.
- The three visual references are now supplied. Gemini's follow-up comparison failed with "Connection stalled repeatedly"; no reference-fidelity verdict was produced. The earlier missing-reference note is historical, not current. Architect alternatives contain conceptual features that must not be fabricated in the product.
- Next scoped milestone is M1 local Git repository discovery/selection/inspection, after human safety review as feasible. `M1-ONBOARDING-BRIEF.md` prepares the UX and contract questions; no project API/native-picker contract or frontend wiring is confirmed here. M2–M4 remain unspecified.
- Fresh read-only preflight preserved the working tree. Fetched main advanced to `5bdecc5b32b74acb065aea5a9c2eecf82cbb01e9`, four docs-only commits after the tested base. No additional merge or publishing occurred. Coordinate latest-main alignment before a frontend PR.

## Current state: A1–A3 technically accepted; Gate A sign-off pending (2026-10-24)

- Repo `/Users/princem/paradox`, branch `feat/ui-shell`, HEAD `10d56898e8a50f72e92285c8a0471d9c9f7f1227` (equal to fetched `origin/main` after Prince's approved fast-forward).
- All Gate A work is **uncommitted** in `apps/studio/` only. No backend, engine, demo_app, root tests/contracts/config, or desktop files were touched.
- No paid generation was run. Every automated generation used `provider: "scripted"` on throwaway isolated engines.
- Ledger with root causes, scenarios, exact results and open risks: [`GATE-A-LEDGER.md`](GATE-A-LEDGER.md). Raw command output: `gate-a-evidence/2026-10-24/`.
- The suspension record `SHUTDOWN-CHECKPOINT-2026-10-24-1300-PDT.md` is historical and unchanged.

Fixes, by priority:
- **A1, provider default.** `initialProvider` picks `scripted` whenever it is available, or nothing, in dev and production alike. The engine default and `VITE_PARADOX_SAFE_PROVIDER` are no longer consulted. Paid confirmation is unchanged.
- **A2, composer parent.** Separate per-engine session state (`composerParent`). It defaults to the engine's live timeline, and an explicit choice is labelled and has **Use live**. Selection, inspection and generated children never change it. Declined or missing choices block submission.
- **A3, reload before the POST response.** The pending request is stored per engine before the POST and reconciled against the generation list by attributes plus "not previously known". A lone match is labelled unconfirmed. Several matches are listed with Inspect, Cancel and Track. No match is stated honestly. Nothing is resubmitted.

- **Follow-up round (after independent review).** Late POST callbacks only touch the stored pending request they belong to, matched by a local correlation token, so an old response can't erase a newer submission. Only a 4xx clears recovery context. A 5xx, an unreadable or invalid body, or a network failure shows "outcome unknown" and keeps it. A lone match stays an unconfirmed guess until the user tracks or dismisses it, so a later lookalike turns it into a list. The final run gives tsc 0, Vitest 79/79, build 0, oxlint 36 warnings (baseline) and E2E 8/8 under Node v20.20.2 (`export PATH=/Users/princem/.nvm/versions/node/v20.20.2/bin:$PATH`). Details are in `GATE-A-LEDGER.md`.

Lead independently passed all five commands (79 unit tests, 8 isolated E2E) and GPT-6 Sol re-review closed all blockers. See `GATE-A-LEAD-VERIFICATION.md`. Gemini's limited desktop audit and lead responsive production spot-checks are recorded in `GATE-A-VISUAL-AUDIT.md`.

Pending Gate A steps: remaining human checks on familiar clean history and
explicit stable-baseline approval. References are supplied; comprehensive
reference comparison is incomplete and exact mockup replication is not blocking.
Nonblocking findings remain documented. Scoped publication is now authorized.

---

## Historical: stabilization sprint (before PR #16)

The sections below describe the earlier sprint at HEAD `a37f288`. Its git status, test counts and cost-safety notes are superseded by the Gate A section above. In particular, `VITE_PARADOX_SAFE_PROVIDER` no longer exists, and production builds no longer follow the engine's default provider.

## What changed this sprint

### P1-B: engine identity and isolation
- `src/state/engine.tsx` (`EngineProvider`) keys the whole engine-specific subtree by the effective engine base. Switching engines unmounts all of it: workspace state, providers, evidence, selection, the composer strip, pending dialogs and polling. Late responses from the old engine land on unmounted state and are dropped.
- `src/api/client.ts`: `createApi(base)` binds every request to one base. There is no global `api` any more; components use `useApi()` / `useEngine()`.
- Tokens are stored per base (`paradox.token:<base>`). A legacy unscoped `paradox.token` is bound once to the base in use at startup and then deleted, so it can never follow a switch.
- Settings blocks engine switching while a runtime action is in flight, and warns that running generations keep running on the old engine.
- Resource keys in `src/hooks/evidence.ts` include the base as well.
- The `<html data-paradox-engine>` attribute exposes the bound base, which the E2E guard reads.

### P1-A: E2E isolation guard
- `e2e/target.mjs` accepts only loopback http origins with an explicit port, never 8000/8001/5173.
- `e2e/isolated-engine.mjs` is started by Playwright. It uses a fresh temp state, `PARADOX_AGENT=scripted` and a minimal env (no FACTORY key, no token), and writes a lease. It cleans up on SIGTERM and sweeps stale runs at start.
- `playwright.config.ts` starts the engine and Vite (:5174, `VITE_PARADOX_SAFE_PROVIDER=1`) with `reuseExistingServer: false`, so a busy port fails the run.
- `e2e/guard.ts` has three layers:
  - `verifyIsolatedEngine`: the lease matches the target, the process is alive, and state is fresh (root only, 0 generations, scripted default).
  - `assertBrowserTarget`: the page's real bound engine and storage override must equal the isolated engine. It is called before every mutation.
  - `installFirewall`: aborts and records any mutating request to another origin, and any generation POST whose body is not `provider: "scripted"`.

### Cost safety
- `src/lib/providers.ts`: dev builds start on `scripted` when it is available (override with `VITE_PARADOX_SAFE_PROVIDER=1|0`). Production builds follow the engine default.
- Any non-scripted provider shows a "may consume paid credits" note and needs a confirmation dialog before the POST.
- `createGeneration` refuses an empty provider.

### Recovery and long runs
- sessionStorage, scoped per engine, keeps the composer submission, the selection and the inspector-open state.
- A generation the engine reports as running is reattached to the composer strip with Cancel. It is labelled "Restored after reload" or "Reattached", and it is never resubmitted.
- There are no client timeouts. A generation that later returns 404 stops polling and is no longer shown as running.
- A synchronous double-submit guard is in place.

### Responsive
`src/styles/modes.css`, under "Responsive hardening":
- Taller inspector on short screens (≤860px high).
- The Architect map keeps a 920px minimum and stacks its inspector below at ≤1180px.
- Explore becomes one scrolling column at ≤980px, with no overlapping panels.
- The composer strip is height-capped, and the top bar wraps on phones.
- Architect nodes have title tooltips.

## Tests actually run (final pass, all on this code)
- `npx tsc -b`: passes. The e2e folder and Playwright config are now typechecked via `tsconfig.node.json`.
- `npx vitest run`: 49/49 passed across 5 files:
  - `app.test.tsx` 17, `engine.test.tsx` 12, `longrun.test.tsx` 4, `logic.test.ts` 12, `model.test.ts` 4.
  - Mutation check: removing the engine-keyed remount makes 4 engine tests fail.
- `npm run build`: passes.
- `npx oxlint`: 0 errors, 36 warnings (baseline 32). Same rule families: fast-refresh exports, set-state-in-effect.
- `npm run e2e`: 3/3 passed:
  - mismatch guard;
  - full Explore workflow;
  - refresh during generation plus Confirm-without-activation.
- Guard negatives checked by hand:
  - :8000, a remote host and :5173 are rejected at config load;
  - a pre-running engine on the target port makes Playwright refuse to start;
  - a used (non-fresh) engine is rejected by `verifyIsolatedEngine`.
- Browser checks against an isolated engine (:8012/:5176, since shut down):
  - screenshots at 1440×900, 1024×768, 820×1180, 768×1024, 390×844;
  - keyboard tab order;
  - engine switch to an unreachable URL and back: 0 requests to the old engine after the switch.

## Known limitations
- Frontend:
  - On desktop, the portal can cover canvas nodes on the far right (pan or Fit to see them).
  - Phones are usable but not polished.
  - Mode nav uses Tab/Enter, not arrow keys.
  - React Flow sometimes logs a benign "ResizeObserver loop" message in dev.
  - Analyze/Architect deep state (chosen lens, A/B picks) is not restored after a refresh.
- Backend-dependent:
  - There are no events or websockets, so the studio polls.
  - There is no direct A↔B diff endpoint (Analyze says so).
  - There is no architecture or telemetry API (Architect says so).
  - Whether the engine marks interrupted runs failed after its own restart is the engine's behaviour.
  - Real Droid runs were not exercised, by design.

## Next steps
1. Prince/Abhi run the human checklist (in the final report) against the integrated backend.
2. For integration testing on a production build, set `VITE_PARADOX_SAFE_PROVIDER=1` so the composer starts on scripted.
3. Commit only on instruction (see the plan in the final report). Exclude `.cursor/` and the repo-root `package.json`/`package-lock.json`/`apps/web/`, which were not part of this work.
