# Slice 4 — Analyze

## Scope

Figma Make's Analyze composition (page title with evidence key, Baseline ⇄
Comparison header, section tabs, main panel plus a right-hand evidence column)
is adapted onto the existing data-grounded Analyze view. Data sources, hooks,
comparison logic (`src/analyze/compare.ts`) and the Validation, Files, Diffs and
Logs tabs are unchanged in behaviour.

The Figma prototype's validation score, sparkline, bundle-size and "improved
clarity" tradeoffs are illustrative data and were **not** transferred. In their
place, an "Evidence coverage" column shows each side's real engine validation
result and test counts, and lists what is not measured: runtime performance,
vulnerability scanning (the guard check only enforces protected paths) and a
direct A↔B patch (no cross-future diff endpoint).

## Changes

- `src/analyze/AnalyzeView.tsx`: title block with an Observed/Unavailable key;
  Baseline (A) and Comparison (B) slots with real status and file counts; swap
  button; Files tab count (aria-hidden, so tab names stay stable); Summary grid
  with the coverage column.
- `src/styles/analyze.css` (imported in `src/main.tsx`): Analyze-scoped styling
  matching the Architect header treatment; stacks below 1180px and 760px.
- `src/test/analyze.test.tsx`: coverage shows recorded validation and labels
  three unmeasured items as Unavailable; swap and every tab send no mutations.

Selecting, swapping or browsing tabs never activates a future. Explore and
Architect, the backend, the API client, runtime actions and the `#projects`
mount are untouched.

## Test evidence (run on this tree)

- `tsc -b`, production build: pass.
- Vitest: 90 tests pass across 12 files (2 new).
- Oxlint: 0 errors, 36 existing warnings.
- Isolated Scripted Playwright: 10 pass (ports 8010/5174; lease and servers cleaned up).
- Read-only screenshots of Explore, Architect and Analyze at 1440×900, 1280×800,
  1024×768 and 1920×1080 against the review environment: no horizontal overflow,
  0 mutating requests. Keyboard order: A, swap, B, tabs, card links, then nav.

## Remaining cosmetic items (not fixed)

- At 1024 the shared top bar wraps to two rows (Slice 1 shell behaviour).
- Explore polish ledger from Slice 3 still applies.
- Native desktop window sizes were checked in Chrome, not in the Tauri shell.

## Review environment

`http://127.0.0.1:5196/#analyze` (Vite on this worktree, engine :8032, Scripted only).
