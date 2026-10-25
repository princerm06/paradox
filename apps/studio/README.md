# Paradox studio

React workspace for Paradox, the software time machine. It reads the timeline engine (default `http://127.0.0.1:8000`) and shows the live application from the engine's `app_url`.

```bash
cd apps/studio
npm install
npm run dev          # http://localhost:5173
```

The existing prototype stays at `apps/prototype` on port 3000.

## Engine connection

| Setting | How |
|---|---|
| Engine URL | `VITE_PARADOX_API_BASE=http://127.0.0.1:8000 npm run dev`, or **Settings → Engine URL** (stored in this browser; **Reset** returns to the build default). |
| Token | If the engine runs with `PARADOX_TOKEN`, enter it in **Settings → Engine token**. It is sent only on mutating requests (as `Authorization: Bearer …`). |
| CORS | The engine allows `localhost`/`127.0.0.1` on ports 3000 and 5173 by default. For other ports set `PARADOX_CORS_ORIGINS` on the engine. |

Start the engine from the repository root (see `engine/README.md`):

```bash
.venv/bin/python -m engine --port 8000          # PARADOX_AGENT=scripted for offline rehearsals
```

## Modes

**Explore**: spatial timeline graph, live portal, floating composer, and the future inspector.
- Selecting or inspecting a future **never** changes the runtime. The portal and the "Live" chip always follow the engine's `active_timeline_id`.
- The composer has a parent picker, agent readiness from `GET /api/agents`, an optional name, and an explicit **Keep live / Go live on success** choice. **Keep live** is the default, and the choice resets after every submission. Progress, failures and cancellation come only from engine responses.
- **Parent.** The composer's parent is its own state, separate from graph and inspector selection. By default it follows the engine's `active_timeline_id` (labelled *live*). Picking another future in **From** makes it *chosen*, kept per engine across refreshes until **Use live**. Selecting, inspecting or generating a future never changes it. A chosen parent that is later declined or deleted blocks submission with a message; the studio never falls back to another parent on its own.
- **Agent provider.** In every build, the composer starts on the free `scripted` provider when the engine reports it available, whatever the engine's default. If scripted is unavailable it starts on no provider and asks for an explicit choice. Any non-scripted provider shows a paid-credits note and needs a cancellable confirmation before the POST. The choice is not persisted, so a refresh or engine switch returns to scripted (or none).
- **Reload before the engine answers.** Before the POST, the composer stores the request (prompt, parent, provider, name, activation, and the generation IDs already known) per engine in session storage. If the page reloads before the response arrives, it looks for engine records created after that point with identical attributes. Exactly one match is tracked with progress and Cancel, labelled as unconfirmed, because an identical request from another client would look the same. Several matches are listed with Inspect, Cancel and **Track this one**. No match says so and offers **Check again** and **Dismiss**. Nothing is ever resubmitted, deleted or invented.
- Inspector tabs are Overview, Diff, Logs, Tests and Snapshots. Each tab loads independently, so a missing diff doesn't blank the logs.
- Runtime actions are **Make live**, **Confirm**, **Decline**, **Save snapshot** and **Restore**. Each one is a direct engine call. Every action except Save snapshot opens a confirmation that explains what changes in the runtime. After every action the studio refetches the engine state rather than assuming the outcome.

**Architect**: a map assembled from real sources, each labelled by where it comes from.
- *Observed*: live engine responses (health, agents, `/openapi.json`, timelines, generations).
- *Documented*: the frozen contracts in `docs/api-contract.md` and `docs/contracts/m2-generation.md`.
- *Inferred*: relations derived from file paths, e.g. a change to `demo_app/ranking.py` maps to the ranking seam.
- Lenses are System (local stack and boundaries), Endpoints (the live OpenAPI operations, with request and response fields) and Changes (the selected future's changed files and diff hunks).
- There is **no** source dependency graph and **no** runtime metrics, because the engine has no API for them. The UI says so.

**Analyze**: compare any two futures (timelines, or attempts without a timeline). Choosing A and B never activates either one.
- Tabs are Summary, Validation (a check matrix in contract order), Files, Diffs and Logs.
- Each diff is labelled as relative to its **own** base snapshot. The engine has no A↔B diff endpoint, so the studio never presents one.

## Testing

```bash
npm run typecheck
npm run lint
npm test             # Vitest + Testing Library against a contract fixture (src/test/fakeEngine.ts)
npm run build
```

`npm test` covers these areas:
- Selection, inspection and comparison send no mutating request.
- Actions require confirmation. Cancel sends nothing. Engine errors are shown, and the live state follows the engine.
- Stale diff responses never render under a newer selection.
- Generation lifecycle: activation is off by default, and unknown statuses never look like they are running. A 409 on cancel shows the engine's real terminal status.
- The diff parser, check labelling, comparison caveats, and Architect provenance (including against a copy of the live OpenAPI schema).
- Offline and first-run states.
- Engine identity (`src/test/engine.test.tsx`): switching engines replaces all records, drops stale responses, stops the old engine's polling, keeps tokens per engine, and blocks switching during a runtime action. Paid providers need confirmation. Refresh reattaches running generations and restores the inspector without resubmitting.
- Gate A (`src/test/gateA.test.tsx`, `src/test/recovery.test.tsx`): the provider starts on scripted in production and dev builds, with none when scripted is unavailable; paid cancellation; refresh and engine-switch resets. The composer parent stays independent of selection, inspection and generated children, and is checked against the POSTed `parent_id`. Reload before the POST response covers a fresh session, a prior completed submission, completion or cancel after reload, ambiguous and lookalike matches, no match, a late list, and engine switches.

### Browser tests (real mutations, isolated engine only)

`npm run e2e` drives Chrome through generate → inspect → make live → snapshot → failed generation → cancel → restore → decline → Analyze/Architect, then refresh-during-generation and confirm-without-activation. The Gate A specs hold the real engine's `POST /api/generations` response after the engine has accepted it (`holdNextGenerationResponse` in `e2e/guard.ts`, which applies the firewall's checks first). Then they reload, run identical concurrent requests, let a run complete during the reload, or switch engines. A last spec checks the default provider and parent and the POSTed `parent_id`. Vite runs without `VITE_PARADOX_SAFE_PROVIDER`, which the studio no longer reads. These steps really mutate engine state, so the run isolates itself:

- Playwright starts its own engine (`e2e/isolated-engine.mjs`): fresh temp state dir, `PARADOX_AGENT=scripted`, a minimal environment with no Factory key or token, ephemeral runtime port. It also starts Vite on :5174 bound to that engine. Neither server is reused; a busy port fails the run.
- `e2e/target.mjs` only accepts loopback http origins with an explicit port, and never 8000, 8001 or 5173.
- Before the browser opens, `verifyIsolatedEngine` checks the launcher's lease and that the engine is fresh (root timeline only, no generations, scripted default).
- Before each mutation, `assertBrowserTarget` reads the engine the page actually bound to (`<html data-paradox-engine>`, after any Settings override in storage) and fails if it isn't the isolated engine.
- A network firewall aborts any mutating request to another origin, and any `POST /api/generations` whose body does not say `provider: "scripted"`. Any blocked request fails the test.

```bash
npm run e2e          # PARADOX_E2E_SHOTS=/some/dir to save screenshots
# optional: PARADOX_E2E_ENGINE=http://127.0.0.1:8012 PARADOX_E2E_URL=http://localhost:5176 npm run e2e
```

Playwright uses the installed Google Chrome (`channel: "chrome"`), so it doesn't download a browser.

## Demo flow (about 3 minutes)

1. **Explore.** Show the live chip and portal. Click a few futures: the inspector changes, but the runtime does not. Point out the note "Inspection does not switch the runtime".
2. Type `Add a popular ranking` in the composer and keep **Keep live** selected. Watch Queued → Preparing → Generating → Validating. The new future lands as *Pending* and is not live.
3. Inspect it. **Diff** shows `demo_app/ranking.py`. **Tests** shows the six engine checks.
4. Click **Make live**, read the confirmation, and click **Switch runtime**. The portal reloads with "Ordering: popular" after the engine confirms.
5. Type `break the app`. It fails at *compile* and stays a red attempt, with no timeline created.
6. **Analyze.** Compare the popular future (A) with the failed attempt (B). The Validation matrix shows the first diverging check, and each diff carries its own base label.
7. **Architect.** Use System to show where `ranking.py` sits (the documented seam). Use Endpoints to show the live API schema. Use Changes to show the hunks.
8. Optional: **Snapshots → Restore** on Original to return to the start.

With the scripted provider, prompts containing `popular`, `slow`, `break the app`, `failing test` or `delete a test` select the matching recipe (see `tests/fixtures/scripted_agent`).

## Known limits

- The engine has no events or websockets. The studio polls health every 5s, the timeline and generation lists every 15s, and in-flight generations every 1s.
- Sprouting (`POST /api/timelines/sprout`) auto-activates its child, so the studio doesn't offer it. The composer's AI generation path is used instead.
- Logs are tails: 400 lines in the inspector, 2000 in Analyze, marked "(truncated)" when the cap is hit.
- Snapshot restore is limited to the selected timeline's own snapshots, as the engine requires.
