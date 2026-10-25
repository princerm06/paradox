# Slice 3 — Architect

## Scope

Figma Make's exported Architect composition informs the title, lens navigation,
component cards, luminous connections, icon treatments and inspection panel.
The existing provenance-aware model and real evidence hooks remain authoritative.
System describes Paradox's local stack, not imported-project topology.
Supported lenses remain System, Endpoints (live OpenAPI), and Changes (generation
records and unified diffs). Architecture comparison, source dependency analysis,
and unmeasured telemetry remain explicitly unavailable.

Component inspection exposes source-labelled relationships and links to real
changed files. Explore inspection and existing Analyze comparison remain reachable;
Analyze itself is not redesigned in this slice. No backend contracts, providers,
runtime code, activation/restoration controllers or authentication code are changed.

## Explore final-polish ledger (deferred, user reported)

- Minimap overlaps the lower-right future card.
- Zoom controls overlap the upper future card.
- Improve graph spacing, branch visibility and card hierarchy.
- Bring preview and inspector styling closer to Figma.

These are recorded follow-ups, not claimed fixed by the Architect slice.

## Verification boundary

Scripted-only disposable review state; no paid generation. Provider availability
does not verify imported-project generation or the full real-Droid desktop workflow.
Browser validation does not establish native desktop readiness. Coordinate any
new separately versioned portable build with Abhi after final regression approval.

## Review environment

- Studio: `http://127.0.0.1:5196/#architect`
- Engine: `http://127.0.0.1:8032`
- Fresh disposable state, isolated HOME, Scripted provider only; no token required.
- A real successful Scripted popularity generation supplies the changed-file
  overlay and unified diff. Its future remains pending/inactive; Original is live.
- In Architect, select the generated future, inspect Ranking seam or Validation,
  then use Changes for the actual diff or Endpoints for live OpenAPI operations.
- Zoom and Fit map are overview tools; scroll/zoom in for readable component text.
  Compact viewports stack the inspector beneath the map, not over it.
- Existing review and recording states are retained, not reset. Older redesign
  Vite servers use the same worktree and may hot-reload its presentation; they are
  not frozen source artifacts.

## Test evidence

- TypeScript and production build pass. Vite reports a main-chunk size advisory.
- Vitest: 88 tests pass across 11 files, including 2 new Architect tests.
- Oxlint: 0 errors; 36 existing warnings.
- Isolated Scripted Playwright: 10 tests pass, including Architect relationship
  inspection, zoom, all supported lenses, card separation and viewport checks at
  1440, 1024, 768 and 390 pixels. The Architect test sends no mutations and
  verifies timeline records and the active future are unchanged.
- Focused backend lifecycle/auth/CORS tests: 23 pass; one dependency deprecation.
- Existing E2E covers generation, real evidence, guarded activation, restoration,
  independent generation-parent selection and pending-request refresh recovery.
- No native build, imported-project generation or paid Droid workflow verified.

## Files in this slice

- `src/architect/ArchitectView.tsx`: composition, source-labelled relationships,
  always-visible coverage limits and evidence navigation.
- `src/architect/ArchCanvas.tsx`: component icon treatments, card hierarchy,
  keyboard-scrollable graph, zoom/fit and connection emphasis.
- `src/styles/architect.css`, `src/main.tsx`: Architect-scoped styling/import.
- `src/test/architect.test.tsx`, `e2e/isolated.spec.ts`: read-only and responsive
  regression coverage.
- `REDESIGN-SLICE-3.md`: scope, evidence and deferred polish ledger.

The architecture adapter, evidence loaders, backend, runtime actions and Analyze
implementation are unchanged. This is ready for visual review, not a desktop
release or an approved merge. Analyze waits for the user's Architect review.
