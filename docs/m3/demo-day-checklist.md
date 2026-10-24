# Cal Hacks demo-day checklist

Two tracks. **Track S (scripted)** always works offline and is the default. **Track L (live Droid)** is used only if the third paid verification has passed (`verification-plan.md` §3–4), and only with the user's go-ahead on the day.

## T-24h

- [ ] `main` has the approved merges (`verification-plan.md` §1). Note the SHA: `________`
- [ ] A clean checkout on the demo laptop: `.venv` installed, `npm --prefix engine/droid_adapter ci --ignore-scripts && npm --prefix engine/droid_adapter run build`
- [ ] Full offline suites are green on that SHA
- [ ] Studio built from the pushed `feat/ui-shell` / `apps/studio` commit: `________`
- [ ] `apps/prototype` still works, as the UI fallback
- [ ] Pin versions: `droid --version` = `________`, `@factory/droid-sdk` 0.10.0 (lockfile)
- [ ] Factory credit balance checked: `________` (each live run has cost 5k–134k credits)
- [ ] Wi-Fi fallback ready (phone hotspot). Track S needs no network.

## T-1h: rehearsal (Track S)

- [ ] `python scripts/demo_rehearsal.py` → **PASS** (exercises create, switch, isolation, diff, confirm, decline, a failing recipe and cancel)
- [ ] `python scripts/demo_rehearsal.py --keep-running`. Note the printed state dir and app URL, then open the studio against it.
- [ ] The engine is started with `PARADOX_AGENT=scripted` (even when the key exists), so no stray request can spend credits
- [ ] The browser is zoomed for the projector, with notifications off

## On stage: Track S script (about 3 min)

1. **The original app.** The feed is chronological. Like and post something to show it's live.
2. **Create an AI future.** Prompt: "Rank the feed by popularity, most liked first." A ghost node appears, moves through queued → generating → validating, then becomes a real timeline.
3. **Inspect it.** Show the diff (`demo_app/ranking.py` plus a new test), the validation checks (guard, compile, tests, boot, smoke) and the provenance panel.
4. **Switch to it.** The same data now appears in popular order. Post something in the future.
5. **Switch back.** The original is untouched and the future's post is absent. *This is the isolation story.*
6. **A failed future.** Prompt: "break the app". It goes red at stage `compile`, no timeline is created, and the parent is unaffected.
7. **Confirm** the good future and **decline** a spare one.

## Track L (only if the third run passed and the user OKs it)

- [ ] Start the engine **from the terminal that has Keychain access**:
  `FACTORY_API_KEY="$(security find-generic-password -a "$USER" -s paradox-factory-api-key -w)" .venv/bin/python -m engine`
- [ ] `curl -sS localhost:8000/api/agents` → droid `available: true`
- [ ] Run **one** generation with `provider: "droid"` explicitly. Expect **several minutes**. Fill the time with steps 3–5 on an existing scripted future.
- [ ] If it fails or runs past about 6 min, cancel and switch to Track S. Show the recorded real sessions instead (`docs/m3/factory-sponsor.md` §3).
- [ ] After the demo, stop the keyed engine (Ctrl-C) so nothing else can spend credits

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
| The studio shows the engine offline | `curl -sS localhost:8000/api/health`. If it's dead, restart the engine with the same state dir (timelines and data survive a restart). |
| The app pane is blank | `GET /api/timelines`, then activate the active timeline again to restart the runtime |
| A generation is stuck | Cancel it from the UI (`POST /api/generations/{id}/cancel`) |
| The studio is broken | Serve `apps/prototype` (`python3 -m http.server 3000 --directory apps/prototype`) |
