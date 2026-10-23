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
  "modification": null,
  "is_active": true
}
```

IDs are opaque UUIDs, including root. Status: `pending`, `confirmed`, `declined`.
Confirm accepts a future without merging. Decline archives a future, preserving
snapshots; declining the active future returns to the nearest non-declined
ancestor. Descendants are not automatically declined. Decisions are idempotent;
already-decided futures cannot change decisions. Root cannot be declined.
`modification` is `null` for the root, `popular_feed` or `none` for newly created
children. It records the sprout operation, not the currently restored behavior:
an unchanged child of a popular parent still has `modification: "none"` and
inherits popular code. Legacy timelines without recorded provenance return null.

## Endpoints

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/health` | — | `{ "status": "ok", "active_timeline_id": "…", "runtime_running": true }` |
| GET | `/api/timelines` | — | `{ "timelines": [Timeline], "active_timeline_id": "…", "app_url": "https://engine.example/app/" }` |
| POST | `/api/timelines/sprout` | `{ "name": "Popular feed", "modification": "popular_feed", "parent_id": "uuid" }` | Timeline (201), activated automatically |
| POST | `/api/timelines/{id}/activate` | — | Timeline |
| POST | `/api/timelines/{id}/confirm` | — | Timeline |
| POST | `/api/timelines/{id}/decline` | — | Timeline |
| GET | `/api/timelines/{id}/snapshots` | — | `{ "snapshots": [Snapshot] }`, oldest first |
| POST | `/api/timelines/{id}/snapshots` | — | Snapshot (201); active timeline only |
| POST | `/api/timelines/{id}/restore` | `{ "snapshot_id": "…" }` | Timeline; activates and restores that timeline's snapshot |

All sprout fields are optional: `name` defaults to `Popular feed` (1–120 chars),
`modification` defaults to `popular_feed`, and omitted/null `parent_id` selects
the active timeline. An explicit parent can be any non-declined timeline. Active
parents contribute their current live state; inactive parents contribute their
latest saved snapshot, never the active workspace. The outgoing active timeline
is always checkpointed before activating the child, even if it is not the parent.
Invalid/declined parents return 404/409 without stopping the runtime.

`none` creates an unchanged child. Snapshot fields: `id`, `timeline_id`,
`created_at`. Switching checkpoints outgoing code AND SQLite data, restores
incoming files, then restarts a single runtime. Snapshots are immutable. Restore
checkpoints outgoing state first, even when restoring the same timeline.

Errors: `{ "detail": "message" }`; 404 unknown ID, 409 invalid lifecycle action,
422 invalid request, 503 transition failure (previous timeline restored when
possible). Mutations and proxied app traffic serialize behind one gate. Refetch
timelines and reload iframe after mutations. No events/websockets yet.

## Embedded demo runtime

Use the absolute `app_url` from `/api/timelines` for the iframe, not the frontend's
origin or the raw runtime port. Configure it through `PARADOX_APP_URL`, for example
`https://fork.example/engine/app/`, or the `create_app(app_url=...)` argument
(takes precedence). A missing trailing slash is added. Only absolute HTTP(S) URLs
without credentials, query, or fragment are accepted. Invalid configuration fails
at app creation. Without explicit configuration the URL derives from the engine
request's base URL plus `app/`, including ASGI `root_path`. Reverse proxies must
preserve the public host/scheme or configure `PARADOX_APP_URL` explicitly.
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
`PARADOX_APP_DIR=workspace/state/` holds `app.sqlite3`. A legacy `behavior.json`
may also be copied but does not control ranking. `demo_app/ranking.py` must expose
`ORDERING: str` and `rank(posts) -> list[dict]`. Baseline `ORDERING` is
`chronological`, ordering by `created_at DESC, id DESC`. `popular_feed` replaces
only `workspace/code/demo_app/ranking.py` with engine-owned template
`engine/templates/popular_ranking.py`: `ORDERING = "popular"`, ordering by
`likes DESC, created_at DESC, id DESC`, returning a new list without mutating input.
The original demo source is never modified. Missing ranking.py fails the sprout
with 503 and rolls back to the outgoing active timeline. Both code and state trees
are snapshotted; source edits are preserved independently.
`ranking.py` is a replacement seam: keep only `ORDERING` and `rank` there, and
pass plain dictionaries with `likes`, `created_at`, and `id` into `rank`.
Integrate the ranking-aware demo together with this engine. Existing state
directories from the behavior.json-based prototype contain legacy code snapshots;
use a fresh `PARADOX_STATE_DIR` after integration (archive old state if needed).
Runtime readiness uses `/health`. Demo seeds SQLite on first startup only.
The single managed runtime stops before code/DB copying and restarts on the same
loopback port. The listening socket uses `SO_REUSEADDR` before binding so repeated
switches can rebind on macOS; no `SO_REUSEPORT` or parallel timeline runtime is used.
Reserve the runtime port for the engine: on macOS, `SO_REUSEADDR` may coexist with
a wildcard listener on the same port. Exact duplicate loopback listeners are
rejected. Proxy redirects retain the configured public app path/root path.

Tests use lifespan-enabled `TestClient(engine.api.create_app(state_dir=...,
runtime_port=..., runtime_source=..., app_url=...))`. Source defaults to bundled demo; port 0
allocates an ephemeral port. Startup creates root and starts runtime; shutdown
stops runtime and checkpoints active timeline.
