# Paradox prototype

Dark workspace for navigating working futures of Sample Feed. It is plain HTML, CSS, and JavaScript with no build step, so it can later be split into React components without changing the engine client.

## Run

From the repository root, start the timeline engine with the scripted provider, then serve this directory:

```bash
PARADOX_AGENT=scripted .venv/bin/python -m uvicorn engine.api:app --host 127.0.0.1 --port 8000
```

```bash
python3 -m http.server 3000 --directory apps/prototype
```

Open [http://localhost:3000](http://localhost:3000). The engine is expected at [http://127.0.0.1:8000](http://127.0.0.1:8000). The live app URL comes from `GET /api/timelines` and is not hardcoded.

`PARADOX_AGENT=scripted` uses the offline recipes in `tests/fixtures/scripted_agent`. Factory Droid is advertised by `GET /api/agents` and stays unavailable unless that provider's own requirements are installed. Do not put `FACTORY_API_KEY` or `PARADOX_TOKEN` in the frontend.

If the engine is started with `PARADOX_TOKEN`, save the same value in Settings. It is kept in this browser's local storage and sent as `Authorization: Bearer` on POST requests only.

## Files

- `index.html` — workspace shell
- `styles.css` — design tokens and layout
- `api.js` — engine client and error parsing
- `app.js` — state, graph, views, preview, and notifications

## Connected endpoints

- `GET /api/health`
- `GET /api/timelines`
- `POST /api/timelines/sprout`
- `POST /api/timelines/{id}/activate`
- `POST /api/timelines/{id}/confirm`
- `POST /api/timelines/{id}/decline`
- `GET /api/timelines/{id}/snapshots`
- `POST /api/timelines/{id}/snapshots`
- `POST /api/timelines/{id}/restore`
- `GET /api/agents`
- `POST /api/generations`
- `GET /api/generations`
- `GET /api/generations/{id}`
- `GET /api/generations/{id}/logs`
- `GET /api/generations/{id}/diff`
- `POST /api/generations/{id}/cancel`
- `GET /app/api/posts` — live ordering only, for the active timeline

Sprout modifications are `popular_feed` and `none`. Generations send `activate_on_success: false` unless that checkbox is turned on.

## Keyboard

`C` create a sprout, `G` generate, `E` enter the selection, `F` fit the graph, `-` / `=` zoom, arrow keys move the selection, `1`–`5` switch views, `P` expand the preview, `Esc` closes overlays.

## Not in this milestone

Promotion is still unavailable. The interface does not invent memory, authentication reliability, or error-rate metrics. Evaluation shows only the checks, test counts, and durations returned by the engine.
