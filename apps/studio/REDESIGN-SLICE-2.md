# Explore visual fidelity — slice 2

## Scope

Continues the uncommitted slice 1 work on the isolated `feat/figma-redesign`
worktree. This slice changes Explore presentation and graph framing only.
Architect and Analyze retain their existing implementations; no backend, API
contracts, storage, authentication, generation controllers, or native packaging
changes are included.

The supplied Figma Make source remains the visual reference: split future cards,
violet selection, cyan live state, compact lifecycle badges, branching curves,
cosmic canvas depth, preview branding, inspector tabs, and composer hierarchy.

## Changes

- Future cards use a split artwork/content composition with two-line names,
  separate Live and Selected badges, lifecycle status, parent/time metadata, and
  the existing explicit Inspect action. Failed/cancelled attempts remain ghosts,
  never successful timeline records. A pending timeline stays labeled Pending,
  not conflated with a running generation or a fabricated validation score.
- No thumbnail or screenshot fields exist in the current Timeline contract.
  Decorative branching art is explicitly labeled **No capture** and exposes an
  unavailable-capture accessible name. No screenshot, feed, or runtime image is
  invented; no iframe is loaded inside a future card.
- Card geometry is 288×160, with increased branch-column and sibling spacing.
  Real parent links still drive the deterministic tree. Focus remains readable
  on narrow canvases by prioritizing the selected node; Fit provides the wider
  overview. Zoom percentage comes from the actual React Flow viewport.
- Canvas controls reserve their own top strip. The legend and real minimap
  reserve bottom space. The minimap colors reflect live/failed/other records,
  while missing previews are never represented as running applications.
- Subtle violet/cyan light fields, dotted depth, softer branch halos, compact
  panel borders, and restrained surface gradients replace heavy node rails.
  Reduced-motion support remains in effect, including zoom button transitions.
- The real preview receives an identity header and backend-derived runtime
  status. Its iframe and refresh behavior are unchanged. Inspector hierarchy and
  tabs and the real generation composer's caption/input/options are refined.
  All original guarded activation/restoration controls remain intact.

## Verification

| Check | Result |
| --- | --- |
| TypeScript and production build | Passed |
| Vitest | 86 passed across 10 files |
| Isolated Scripted Playwright | 9 passed |
| Focused backend engine/authentication checks | 23 passed |
| Oxlint | 0 errors, 36 existing warnings |
| Whitespace | `git diff --check` passed |

New unit checks cover deterministic/non-overlapping enlarged cards, preservation
of failed/cancelled ghost types, and truthful unavailable-capture artwork.
Browser coverage checks selected/live badges independently, Fit bounds, actual
zoom changes, and all existing generation/inspection/activation/restoration and
Gate A workflows.

Read-only populated visual QA covers 1440×960, 1280×720, 1024×768, 768×1024, and
390×844 with three real timeline records. Checks verify no card overlap, no
horizontal document overflow, in-bounds selected cards, separated preview and
inspector panels, and actual validation evidence. On narrow screens the graph
remains pannable: ancestors and siblings may intentionally be offscreen while
the selected card is centered. This is not a claim that every node fits at once.

The collaborative browser twice timed out during snapshot inspection. Visual
QA therefore used the repository's Playwright/Chrome workflow, not an assumed
successful browser-tool inspection. No desktop build or native rehearsal was
performed. The existing development dependency audit findings documented in
slice 1 are unchanged; no dependency or lockfile updates were made.

## Review instance

- Studio: `http://localhost:5192/`
- Engine: `http://127.0.0.1:8028`
- Authentication: none for this disposable loopback-only review instance.
- Fresh state lives in a newly allocated temporary directory, outside all
  existing timeline databases. The engine started with a clean environment,
  Scripted recipes, no inherited API keys/tokens, and an ephemeral runtime port.
- Two real Scripted generations succeeded: **Popular ranking** and **Safe
  experiment**. Both remain pending and inactive; **Original** remains live.
  Popular ranking changes the ranking implementation and adds a test; Safe
  experiment uses the slower harmless-module recipe, not a second invented UI.
- Click **Inspect** on Popular ranking to compare its selected badge with
  Original's live badge and open real Diff/Tests evidence. Selection alone never
  switches the preview. The application preview continues to serve Original.

The prior slice 1 review processes/state, verified recording environments,
installed desktop application, and original checkout were not stopped, reset,
or mutated. Since slice 1 and slice 2 use the same redesign source worktree, its
older Vite review server may hot-reload presentation changes; it is not a frozen
slice 1 artifact. Its timeline data is left alone. Use the new URL for this
slice's isolated, populated review state.

## Files added or changed for this slice

- `src/graph/FutureVisual.tsx`, `src/graph/FutureVisual.test.tsx`
- `src/graph/TimelineNode.tsx`, `src/graph/GhostNode.tsx`
- `src/graph/layout.ts`, `src/graph/layout.test.ts`
- `src/graph/BranchEdge.tsx`, `src/graph/TimelineCanvas.tsx`
- `src/styles/explore.css`, `src/main.tsx`
- `src/preview/LiveWorkspace.tsx`, `src/composer/PromptComposer.tsx`
- `src/views/WorkspaceView.tsx`, `e2e/isolated.spec.ts`
- `REDESIGN-SLICE-2.md`

Remaining fidelity limits: no genuine per-future image captures, no bundled
Inter/DM Mono files in the export, and the real demo application's own content
and styling intentionally differ from Figma's illustrative feed. No new
telemetry, architecture analysis, or unsupported product feature is implied.

Ready for visual review, not merged or published. Architect/Analyze redesigns,
further implementation slices, and push/merge operations await approval.
