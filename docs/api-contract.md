# Paradox engine API — milestone 1

**Implemented contract agreed by Codex 1 and Codex 2.** The larger proposal in
`proposed-api-v0.md` is future work, not the current API. OpenAPI: `/docs`.

Base URL `http://127.0.0.1:8000`. Engine endpoints use `/api`. CORS allows
localhost/127.0.0.1 on ports 3000 and 5173. Local development only: no auth or
untrusted-code sandbox. Run one engine worker.

## Timeline

```json
{
  "id": "uuid",
  "parent_id": null,
  "name": "Original",
  "status": "confirmed",
  "created_at": "2026-10-23T00:00:00+00:00",
  "snapshot_id": "uuid",
  "is_active": true
}
```

IDs are opaque UUIDs, including root. Status: `pending`, `confirmed`, `declined`.
Confirm accepts a future without merging. Decline archives a future, preserving
snapshots; declining the active future returns to the nearest non-declined
ancestor. Descendants are not automatically declined. Decisions are idempotent;
already-decided futures cannot change decisions. Root cannot be declined.

## Endpoints

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/health` | — | `{ "status": "ok", "active_timeline_id": "…", "runtime_running": true }` |
| GET | `/api/timelines` | — | `{ "timelines": [Timeline], "active_timeline_id": "…", "app_url": "/app/" }` |
| POST | `/api/timelines/sprout` | `{ "name": "Popular feed", "modification": "popular_feed" }` | Timeline (201), activated automatically |
| POST | `/api/timelines/{id}/activate` | — | Timeline |
| POST | `/api/timelines/{id}/confirm` | — | Timeline |
| POST | `/api/timelines/{id}/decline` | — | Timeline |
| GET | `/api/timelines/{id}/snapshots` | — | `{ "snapshots": [Snapshot] }`, oldest first |
| POST | `/api/timelines/{id}/snapshots` | — | Snapshot (201); active timeline only |
| POST | `/api/timelines/{id}/restore` | `{ "snapshot_id": "…" }` | Timeline; activates and restores that timeline's snapshot |

Sprout branches from active timeline. `modification` defaults to `popular_feed`;
`none` creates an unchanged child. Snapshot fields: `id`, `timeline_id`,
`created_at`. Switching checkpoints outgoing code AND SQLite data, restores
incoming files, then restarts a single runtime. Snapshots are immutable. Restore
checkpoints outgoing state first, even when restoring the same timeline.

Errors: `{ "detail": "message" }`; 404 unknown ID, 409 invalid lifecycle action,
422 invalid request, 503 transition failure (previous timeline restored when
possible). Mutations and proxied app traffic serialize behind one gate. Refetch
timelines and reload iframe after mutations. No events/websockets yet.

## Embedded demo runtime

Iframe URL: `http://127.0.0.1:8000/app/` (not the frontend's origin).
API: `/app/api/posts` (GET/POST), `/app/api/posts/{id}/like` (POST),
`/app/api/health` (GET). Proxy strips `/app`; HTML uses relative URLs.
Create post: `{ "author": "Ada", "content": "Hello" }` → Post (201).
List: `{ "posts": [Post], "ordering": "chronological" | "popular" }`.
Post fields: `id`, `author`, `content`, `likes`, `created_at`.

Runtime port is internal by convention, not a security boundary: direct requests
bypass the gate. Background writers, external services, websockets and untrusted
apps are unsupported in this local milestone.

## Runtime interface and ownership

* Codex 1: `engine/`, root packaging/config, `tests/test_engine*.py`, this contract.
* Codex 2: `demo_app/`, `tests/demo/`, `docs/demo-api.md`, `requirements-demo.txt`.
* Claude: review; coordinate before shared edits.

Engine copies `demo_app/` to `workspace/code/demo_app/`, runs uvicorn
`demo_app.main:app` using current Python from cwd `workspace/code/`.
`PARADOX_APP_DIR=workspace/state/` holds `app.sqlite3` and `behavior.json`.
Initial config is copied from `demo_app/behavior.json`. Deterministic sprout sets
`feed_order` to `popular`; config is read at startup. Both code and state trees
are snapshotted. Source edits in managed code are also preserved independently.
Runtime readiness uses `/health`. Demo seeds SQLite on first startup only.

Tests use lifespan-enabled `TestClient(engine.api.create_app(state_dir=...,
runtime_port=..., runtime_source=...))`. Source defaults to bundled demo; port 0
allocates an ephemeral port. Startup creates root and starts runtime; shutdown
stops runtime and checkpoints active timeline.
