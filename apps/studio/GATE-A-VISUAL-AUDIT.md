# Gate A — limited visual audit, October 24, 2026

Latest human update: Prince finds the Studio solid and functional. Mockup
deviation is provisional P2, not a demo blocker or authorization for redesign.
Architect and Analyze are NOT EVALUATED due to unfamiliar test history, not
visual/UX failures. Crowded history is a test-context limitation, not a confirmed
defect. Comprehensive reference-fidelity evaluation remains incomplete.

This is not reference-fidelity approval. The original audit below preceded
Prince supplying three concept references. Those references are now available
but Gemini's follow-up failed with "Connection stalled repeatedly" and produced
no comparison verdict. No design changes were made.

## Gemini desktop screenshot review

Gemini 4 Argon inspected the 19 final isolated-E2E screenshots in
`/tmp/paradox-gate-a-lead-final-shots/`, all at 1440×900, with supporting styles
and composer code. It found no desktop screenshot release blocker.

Observed strengths: graph/portal prominence, distinct selected/live indicators,
explicit live composer source, visible unconfirmed recovery provenance and
candidate controls, and observed/documented/unavailable evidence boundaries.
Screenshots establish visible state, not independent proof of runtime safety;
the behavioral assertions come from tests and technical review.

Nonblocking findings, not authorizations for redesign:

- P2: parent/provider chips truncate meaningful labels.
- P2: ambiguous candidates use dense, faint ISO timestamps and small actions.
- P2: recovery explanations and candidate rows can approach the scroll cap.
- P3: duplicate `(live)` and `LIVE` labels add repetition.
- P3: after manual activation, the old generation strip can still say to make
  the future live. Lifecycle Pending and runtime Live are distinct, but this
  instructional copy should eventually follow backend-confirmed runtime state.
- Known limitation: portal/inspector overlays can obscure deeper graph nodes;
  pan or Fit remains necessary.
- Technical review separately noted no Dismiss on a running unconfirmed guess.

## Lead responsive production spot-check

A separate production bundle was built with
`VITE_PARADOX_API_BASE=http://127.0.0.1:8022` into
`/tmp/paradox-gate-a-production.IsVD3G`, then served on `127.0.0.1:5178`.
The existing isolated-engine launcher supplied fresh scripted-only state on
8022. The T3 collaborative browser used an incognito tab. No generation,
activation, snapshot or demo-app mutation was performed during these checks.

Observed CSS viewport sizes and document scroll widths:

- 390×844: scroll width 390; wrapped topbar and stacked graph/composer/portal.
  Futures drawer opened; Fit restored graph framing after resizing.
- 1024×768: scroll width 1024; drawer open, composer and portal stayed within
  viewport width; labels remain truncated.
- 820×1180: scroll width 820; drawer and inspector open; composer, inspector and
  portal stack vertically. Lower content requires ordinary page scrolling.
- 1366×650: scroll width 1366; drawer and inspector open; right portal and
  inspector split the short-screen height; composer stayed inside its column.

These are root-timeline Explore spot-checks, not a full responsive sign-off.
No current mobile screenshots of three-plus ambiguous candidates, explicit
non-live parent selection, or Analyze/Architect are claimed.

Saved native browser screenshots (local, outside Git):

- Mobile with drawer:
  `/Users/princem/.t3/userdata/browser-artifacts/browser-screenshot-127-0-0-1-mvmxet9j-e9964b1f.png`
- 1024×768:
  `/Users/princem/.t3/userdata/browser-artifacts/browser-screenshot-127-0-0-1-mvmxf8yp-5681b8d8.png`
- Tablet with drawer/inspector:
  `/Users/princem/.t3/userdata/browser-artifacts/browser-screenshot-127-0-0-1-mvmxg3rg-5c0069fa.png`
- Short desktop with drawer/inspector:
  `/Users/princem/.t3/userdata/browser-artifacts/browser-screenshot-127-0-0-1-mvmxgpwe-0a3d27ae.png`

The owned tab and audit servers were closed; ports 8022/5178 have no listeners
and the 8022 lease was removed. The unrelated shared Vite server was untouched.

## Remaining approval boundary

Prince has now supplied the references. Follow-up comparison, human demo
rehearsal, and explicit stable-baseline approval are still pending.
Gate A is not fully closed. T-AVP Lite, sponsor work and desktop packaging have
not begun as part of this audit.
