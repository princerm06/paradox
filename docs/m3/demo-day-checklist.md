# Cal Hacks demo-day checklist

Two tracks. **Track S (scripted)** always works offline and is the default. **Track L (live Droid)** is available: the third paid verification passed (generation `1c98d768`, 26 tests, adopted). Use it only with the user's go-ahead on the day, and budget about **42k Factory credits per run**.

## T-24h

- [ ] `main` has the approved merges (`verification-plan.md` §1), including the studio (PR #16, merge `bc9d3db`). Note the SHA: `________`
- [ ] A clean checkout on the demo laptop: `.venv` installed, `npm --prefix engine/droid_adapter ci --ignore-scripts && npm --prefix engine/droid_adapter run build`
- [ ] Full offline suites are green on that SHA
- [ ] Studio installed from `main`: `npm --prefix apps/studio ci`. Studio checks green: `npm --prefix apps/studio run typecheck && npm --prefix apps/studio test && npm --prefix apps/studio run build`
- [ ] `apps/prototype` still works, as the UI fallback
- [ ] Pin versions: `droid --version` = `________`, `@factory/droid-sdk` 0.10.0 (lockfile)
- [ ] Factory credit balance checked: `________` (each live run has cost 5k–134k credits)
- [ ] Wi-Fi fallback ready (phone hotspot). Track S needs no network.

## T-1h: rehearsal (Track S)

- [ ] `python scripts/demo_rehearsal.py` → **PASS** (exercises create, switch, isolation, diff, confirm, decline, a failing recipe and cancel)
- [ ] `python scripts/demo_rehearsal.py --keep-running`. Note the printed state dir and app URL, then open the studio against it.
- [ ] The engine is started with `PARADOX_AGENT=scripted` (even when the key exists), so no stray request can spend credits
- [ ] The browser is zoomed for the projector, with notifications off

## T-1h: studio setup (Track S, scripted only)

The studio picks its starting agent like this:
- **Dev server** (`npm run dev`): starts on `scripted`.
- **Production build** (`npm run build` / `vite preview`): starts on the **engine's default**. That is `droid` whenever the engine has a Factory key and `PARADOX_AGENT` is unset.

A paid-confirmation dialog still guards every non-scripted generation, but don't rely on it on stage. Use all three safeguards below.

- [ ] Engine on the default port, scripted by default:
  `PARADOX_AGENT=scripted .venv/bin/python -m engine` (no `FACTORY_API_KEY` in this terminal for Track S)
- [ ] `curl -sS localhost:8000/api/agents` → `"default":"scripted"`. For Track S, droid should be `available: false`.
- [ ] Studio with the scripted default forced:
  `VITE_PARADOX_API_BASE=http://127.0.0.1:8000 VITE_PARADOX_SAFE_PROVIDER=1 npm --prefix apps/studio run dev` → http://localhost:5173
- [ ] If you use a production build instead, build it with the same flag:
  `VITE_PARADOX_API_BASE=http://127.0.0.1:8000 VITE_PARADOX_SAFE_PROVIDER=1 npm --prefix apps/studio run build`
- [ ] **CORS for `vite preview`.** The engine allows only ports 3000 and 5173 by default, and `vite preview` serves on **4173**. Start the engine with the preview origins listed explicitly, keeping 5173 for the dev server:
  `PARADOX_AGENT=scripted PARADOX_CORS_ORIGINS=http://localhost:4173,http://127.0.0.1:4173,http://localhost:5173,http://127.0.0.1:5173 .venv/bin/python -m engine`
  then `npm --prefix apps/studio run preview`. Or run preview on 5173: `npm --prefix apps/studio run preview -- --port 5173 --strictPort`.
- [ ] In the studio the composer chip reads **Agent: scripted**, the top bar shows **Live · Original**, and the engine dot is green.
- [ ] Settings → Engine URL shows "Build default". A leftover override from testing would point the studio at another engine; press **Reset** if it shows one.

## On stage: Track S script (about 3 min)

1. **The original app.** The feed is chronological. Like and post something to show it's live.
2. **Create an AI future.** First check that the composer's **From** chip names the timeline you mean to branch from (see the note below). Prompt: "Rank the feed by popularity, most liked first." A ghost node appears, moves through queued → generating → validating, then becomes a real timeline.
3. **Inspect it.** Show the diff (`demo_app/ranking.py` plus a new test), the validation checks (guard, compile, tests, boot, smoke) and the provenance panel.
4. **Switch to it.** The same data now appears in popular order. Post something in the future.
5. **Switch back.** The original is untouched and the future's post is absent. *This is the isolation story.*
6. **A failed future.** Check **From** again. Prompt: "break the app". It goes red at stage `compile`, no timeline is created, and the parent is unaffected.
7. **Confirm** the good future and **decline** a spare one.

> **Check the From timeline before every Generate.** **From** follows the current selection, not the live timeline. When a generation succeeds, the studio moves the selection onto the new future, so the *next* prompt branches from that future unless you change it. Before each prompt, read the **From** chip. Pick the intended parent in the chip, or click that timeline first. "Original (live)" marks the live one.

## Track L (live Droid; only with the user's OK on the day)

- [ ] Start the engine **from the terminal that has Keychain access**:
  `FACTORY_API_KEY="$(security find-generic-password -a "$USER" -s paradox-factory-api-key -w)" .venv/bin/python -m engine`
- [ ] `curl -sS localhost:8000/api/agents` → droid `available: true`
- [ ] Run **one** generation with `provider: "droid"` explicitly. Run 3 took about 27s of agent time plus about 1 minute of validation; allow up to 6 minutes. Fill the time with steps 3–5 on an existing scripted future.
- [ ] If it fails or runs past about 6 min, cancel and switch to Track S. Show the recorded real sessions instead (`docs/m3/factory-sponsor.md` §3).
- [ ] After the demo, stop the keyed engine (Ctrl-C) so nothing else can spend credits

## Showing the real run-3 Droid result (no paid call)

The successful live run (generation `1c98d768`, timeline "Live official SDK proof", 6/6 checks, 42,278 credits) is preserved at `~/paradox-evidence/droid-proof-3-1c98d768`. That directory is a complete engine state dir. It is **not** imported into a fresh engine automatically, and the original must never be served directly, because a running engine writes to its state dir.

- [ ] Make a throwaway copy, then start a second, keyless engine on it. The runtime port is ephemeral, so it doesn't clash with the main engine's 8001. Run from the repo root:
  ```bash
  VIEW="$(mktemp -d /tmp/fork-run3-view.XXXXXX)"
  cp -Rp ~/paradox-evidence/droid-proof-3-1c98d768 "$VIEW/state" && rm -f "$VIEW/state/engine.lock"
  env -u FACTORY_API_KEY PARADOX_AGENT=scripted VIEW="$VIEW" .venv/bin/python -c 'import os, uvicorn; from pathlib import Path; from engine.api import create_app; uvicorn.run(create_app(state_dir=Path(os.environ["VIEW"]) / "state", runtime_port=0), host="127.0.0.1", port=8002)'
  ```
- [ ] `curl -sS localhost:8002/api/agents` → droid `available: false` ("FACTORY_API_KEY is not configured")
- [ ] In the studio: Settings → Engine URL → `http://127.0.0.1:8002` → **Use**. The top bar shows **Live · Live official SDK proof**. Inspect it for the Droid summary, Diff (`demo_app/ranking.py` plus the test), Tests (all six checks), Logs and the recorded credits.
- [ ] **Look, don't touch.** On this engine, don't press Make live, Confirm, Decline, Save snapshot, Restore or Generate. They would only change the copy, but the copy should stay exactly as recorded.
- [ ] Settings → **Reset** returns to the main engine. Stop the viewer with Ctrl-C and delete `$VIEW`.
- [ ] The original is untouched: `find ~/paradox-evidence/droid-proof-3-1c98d768 -type f | wc -l` → `250`

This procedure was verified on 2026-10-24 with a production build: zero mutating requests, and the original's hash was unchanged.

## What to say (pitch-safe)

- "Each future is a real, running copy of the app, with its own code **and** database."
- "AI futures are written by **Factory Droid via the official TypeScript SDK**. Fork records Droid's session, cost and diff, and only adopts a future after independently compiling, testing and booting it."
- If Track L succeeded on the day: "This future was generated live by Droid."
- Do **not** claim prize eligibility, or that live Droid generation works, unless it succeeded (see `factory-sponsor.md` §4).

## Reset between runs

- Stop the engine (Ctrl-C). Rerun `scripts/demo_rehearsal.py --keep-running` for a fresh state dir. Never reuse a state dir after a failed live run.

## If something breaks

| Symptom | Action |
|---|---|
| The studio shows the engine offline but `curl` works | It's CORS: the studio's origin isn't allowed. Restart the engine with `PARADOX_CORS_ORIGINS` (see studio setup), or serve the studio on 5173. Also check Settings → Engine URL for a stale override. |
| The studio shows the engine offline | `curl -sS localhost:8000/api/health`. If it's dead, restart the engine with the same state dir (timelines and data survive a restart). |
| The app pane is blank | `GET /api/timelines`, then activate the active timeline again to restart the runtime |
| A generation is stuck | Cancel it from the UI (`POST /api/generations/{id}/cancel`) |
| The composer starts on `droid` | Wrong build or engine. Stop, then restart the engine with `PARADOX_AGENT=scripted` and the studio with `VITE_PARADOX_SAFE_PROVIDER=1`. Never confirm the paid dialog during Track S. |
| The studio is broken | Serve `apps/prototype` (`python3 -m http.server 3000 --directory apps/prototype`) |
