# Paradox studio: stabilization sprint handoff

**Status: sprint complete. Verdict: READY WITH LIMITATIONS** for hard human testing (limitations listed below). All work is uncommitted.

- Repo `/Users/princem/paradox`, branch `feat/ui-shell`, HEAD `a37f288` (unchanged).
- Scope: `apps/studio/` only. No backend, engine, demo_app, tests/ or docs files were touched.
- No paid (Droid) generation was triggered. Every generation in automated runs used `provider: "scripted"` on throwaway engines.
- Nothing was committed or pushed. A commit needs an explicit instruction from Prince.

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
