# Paradox prototype

Dark workspace for navigating working futures of Sample Feed. It is plain HTML, CSS, and JavaScript with no build step, so it can later be split into React components without changing the engine client.

## Run

Start the timeline engine from the repository root, then serve this directory:

```bash
python3 -m http.server 3000 --directory apps/prototype
```

Open [http://localhost:3000](http://localhost:3000). The engine is expected at [http://127.0.0.1:8000](http://127.0.0.1:8000). The live app URL comes from `GET /api/timelines` and is not hardcoded.

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
- `GET /app/api/posts` — live ordering only, for the active timeline

Sprout modifications are `popular_feed` and `none`.

## Keyboard

`C` create future, `E` enter the selection, `F` fit the graph, `-` / `=` zoom, arrow keys move the selection, `1`–`5` switch views, `P` expand the preview, `Esc` closes overlays.

## Not in this milestone

Arbitrary natural-language edits, measured evaluation, and promotion are shown as unavailable. The interface does not invent metrics or pretend those actions succeeded.
