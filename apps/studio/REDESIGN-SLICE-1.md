# Figma integration — slice 1

## Scope and provenance

Implementation base: `e920df21ee3b023121354f96bed2c7e00f57374e`, verified against
GitHub main on October 24, 2026. Work is isolated on `feat/figma-redesign`.

The supplied **Build Paradox Software Time Machine.zip** is the primary design
reference. Its application is a single React component with local illustrative
state and global CSS. The manifest uses React 19, Vite 8, TypeScript 5.7, Tailwind
4, and oxfmt. Its Vite configuration and `.figma` scripts are Figma-specific;
none were executed or transferred to Studio.

The exported `paradox-mark.svg` and `favicon.svg` are transferred byte-for-byte.
The obsidian palette, violet/cyan/mint accents, mode icons, navigation treatment,
and canvas/detail composition are adapted from the actual source. Studio keeps
its existing React/Vite/React Flow stack: no dependency or lockfile changes.

The export references Google-hosted Inter and DM Mono but contains no font files.
The shared stacks prefer those families when available and otherwise use local
system fonts. No Google Fonts request is added. Exact font rendering therefore
remains a fidelity difference until approved self-hosted assets are supplied.

## Implemented

- Authentic branching mark in the header and exported browser favicon.
- Shared colors, typography stacks, restrained glass surfaces, focus treatment,
  and reduced-motion support.
- Branded Explore/Architect/Analyze navigation and functional Explore tool rail.
  Compare opens the existing Analyze view; Inspect opens the existing inspector;
  Compose focuses the real generation input. No placeholder actions are added.
- Explore canvas and composer occupy separate grid rows. The real preview and
  optional inspector occupy a separate detail column rather than covering the
  canvas. Detail panels scroll on short screens and stack below on narrow ones.
- Preview expansion reallocates column width instead of overlaying graph nodes.
  Minimap and graph controls occupy opposite corners on large screens; the
  minimap yields on smaller screens.
- The existing graph framing now responds to its host dimensions, keeping the
  selected future visible when the window or panels resize. Selection and runtime
  state are unchanged.

## Preserved boundaries

No backend, API client, workspace/engine state provider, composer controller,
generation provider, runtime action, persistence, or credential handling changes.
The iframe continues to show the backend's actual running application. Selecting
or inspecting a future does not activate it. Explicit parent choice, Scripted
defaults, activation mode, confirmation dialogs, and pending-request recovery
remain the existing implementations.

No prototype histories, architecture components, thumbnails, validation scores,
performance metrics, or simulated feed were imported. Architect and Analyze
retain their current data-grounded functionality; their full visual redesigns
are not part of this slice. M1 onboarding and M2–M4 work remain out of scope.

No existing recording environment, installed application, release artifact, or
shared timeline state was changed. All manual generations and browser mutations
used fresh disposable state and the Scripted provider. No paid generations,
native builds, commits, pushes, or merges were performed.

## Validation

Toolchain: Node 20.20.2 and Python 3.13.11. The shell's older Node 19 cannot run
the existing Vite toolchain; select a supported Node before running commands.

| Check | Result |
| --- | --- |
| Clean-base unit baseline | 79 passed |
| TypeScript | Passed |
| Production build | Passed |
| Unit tests including rail/brand/composer regression coverage | 81 passed |
| Oxlint | 0 errors, 36 warnings; same warning count as baseline |
| Isolated Scripted Playwright | 9 passed, including all 8 existing workflows |
| Backend pytest | 311 passed, 6 skipped; one dependency deprecation warning |
| Patch whitespace | `git diff --check` passed |
| Exported SVG comparison | Both match source byte-for-byte |

The new browser check covers 1440×900, 1280×720, 1024×768, 768×1024, and 390×844:
composer below canvas, inspector below preview, no document horizontal overflow,
selected-card horizontal visibility after resize, and non-overlapping expanded
preview. Existing E2E verifies generation, inactive inspection, real evidence,
activation, snapshots/restoration, failure, cancellation, and Gate A recovery.
Existing unit/backend coverage also exercises authentication. This is not a
native desktop approval or a claim that skipped tests passed.

Reproduce from `apps/studio`, after installing its locked dependencies and setting
up the root Python virtual environment per `requirements-dev.txt`:

```sh
npm run typecheck
npm test
npm run lint
npm run build
PARADOX_E2E_ENGINE=http://127.0.0.1:8024 \
PARADOX_E2E_URL=http://localhost:5188 npm run e2e
```

The existing E2E launcher refuses existing servers and uses fresh temporary
state, a credential-restricted environment, and a request firewall. Choose other
unused non-shared loopback ports if these are occupied; never stop another demo.

## Remaining review items

- This is an incremental shell/layout integration, not full Figma fidelity.
  Future card content, thumbnails, and inspector details retain the real Studio
  implementation. Metadata stays more readable than the prototype's tiny text.
- The rail intentionally exposes supported Inspect/Compose actions instead of
  pretending the prototype's Logs/New interactions implement a separate feature.
- The new theme is layered after existing CSS to keep the first slice reversible.
  Consolidate overlapping legacy layout rules in a later focused cleanup.
- `npm audit` reports three existing development-tool findings: critical `vitest`
  and `tinypool`, and moderate `@vitest/mocker`. The suggested repair upgrades
  Vitest across a major version. Dependency remediation is separate work; no
  audit fix or dependency replacement was applied during the redesign.
- Browser checks do not certify Tauri, native icons, font availability, desktop
  authentication, or a six-step native rehearsal. Coordinate a separately
  versioned package and verification with Abhi before any desktop release.

## Changed files

- `public/paradox-mark.svg`, `public/favicon.svg`
- `src/styles/redesign.css`, `src/main.tsx`
- `src/shell/icons.tsx`, `src/shell/TopBar.tsx`
- `src/views/WorkspaceView.tsx`, `src/graph/TimelineCanvas.tsx`
- `src/test/redesign.test.tsx`, `e2e/isolated.spec.ts`
- `REDESIGN-SLICE-1.md`

Ready for human review as an uncommitted, isolated slice. Further implementation,
PR publication, dependency remediation, and native packaging are separate steps.
