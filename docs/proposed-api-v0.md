# Proposed future API — not the implemented milestone contract

Status: **draft v0**. The frontend builds against this with mock data, and the engine implements it.
Changes go through this file. Additive changes (new fields or endpoints) are fine. Breaking changes need agreement first.

- Engine base URL: `http://127.0.0.1:8000` (env `PARADOX_ENGINE_PORT`)
- Demo app runtime URL: `http://127.0.0.1:8100` (env `PARADOX_APP_PORT`). The frontend iframes `runtime.url`.
- All engine routes are under `/api`. JSON in/out. CORS allows `*` for local dev.
- Errors use FastAPI's native shape: `{"detail": {"code": "<machine_code>", "message": "<human text>"}}`
  - `404 timeline_not_found`, `404 snapshot_not_found`
  - `409 timeline_declined` (can't activate/sprout a declined timeline), `409 invalid_status` (e.g. confirm a non-pending timeline), `409 busy` (if another transition is in progress and the lock wait times out)
  - `422 unknown_mutation` / `422 invalid_mutation`
  - `500 runtime_failed` (app didn't become healthy; `message` includes a log tail)
- Every mutating call is **synchronous**: it returns only after the runtime is healthy on the new state. That takes about 0.5–2s, so the UI should show a transition animation while it waits.

---

## Objects

### Timeline
```json
{
  "id": "tl_3f9a1c",
  "name": "Popularity ranking",
  "description": "Feed ordered by likes instead of recency",
  "parent_id": "root",
  "children_ids": [],
  "depth": 1,
  "status": "pending",
  "is_active": true,
  "created_at": "2026-10-23T23:10:04Z",
  "updated_at": "2026-10-23T23:12:40Z",
  "mutation": { "kind": "feed_ranking", "params": { "strategy": "popularity" } },
  "head_snapshot_id": "snap_91bd02",
  "origin_snapshot_id": "snap_77ac10"
}
```
- The root timeline always has id `"root"`, name `"Original"`, `parent_id: null`, `status: "confirmed"`, `mutation: null`.
- `status`: `"pending"` (freshly sprouted, awaiting decision) → `"confirmed"` | `"declined"`.
- Exactly one timeline has `is_active: true`.
- `origin_snapshot_id` is the state right after sprout + mutation. It never changes.
- `head_snapshot_id` is the latest saved state. It moves every time you leave the timeline or checkpoint it.

### Snapshot
```json
{
  "id": "snap_91bd02",
  "timeline_id": "tl_3f9a1c",
  "kind": "origin",
  "label": "after sprout",
  "code_ref": "a1b2c3d…",
  "created_at": "2026-10-23T23:10:04Z"
}
```
`kind`: `"origin" | "autosave" | "checkpoint"`. `code_ref` is the git commit sha in Paradox's private code store. A snapshot = code commit + SQLite file.

### Runtime
```json
{
  "status": "running",
  "timeline_id": "tl_3f9a1c",
  "url": "http://127.0.0.1:8100",
  "pid": 41233,
  "started_at": "2026-10-23T23:12:40Z",
  "last_transition_ms": 812
}
```
`status`: `"stopped" | "starting" | "running" | "crashed"`.

### Mutation
```json
{ "kind": "feed_ranking", "params": { "strategy": "popularity" } }
```
v0 kinds:
| kind | params | effect |
|---|---|---|
| `feed_ranking` | `strategy`: `"chronological" \| "popularity" \| "hot"` | Rewrites `app/feed.py` in the child's code |
| `write_files` | `files`: `{ "<relpath>": "<content>" \| null }` (`null` = delete) | Generic file edit. This is where AI agents plug in later |

---

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | – | `{"ok": true}` |
| GET | `/api/timelines` | – | `{"active_id": "root", "timelines": [Timeline…]}` (flat list, the graph is built from `parent_id`) |
| GET | `/api/timelines/{id}` | – | `Timeline` |
| POST | `/api/timelines/{id}/sprout` | `{"name"?, "description"?, "mutation"?: Mutation, "activate"?: true}` | `201 Timeline` (the new child). Child status = `pending`. If `activate` (default **true**), the runtime switches to the child before the call returns. |
| POST | `/api/timelines/{id}/activate` | – | `{"active_id", "runtime": Runtime}`. No-op (no restart) if already active. |
| POST | `/api/timelines/{id}/confirm` | – | `Timeline` (status → `confirmed`). Only from `pending`. |
| POST | `/api/timelines/{id}/decline` | – | `{"declined_ids": [...], "active_id", "runtime"}`. Declines the timeline **and all its descendants**. If the active timeline was declined, the engine activates the nearest non-declined ancestor. Root can't be declined. |
| GET | `/api/timelines/{id}/diff` | query `against` = timeline id (default: parent) | `{"base": id, "target": id, "files": [{"path", "status": "added\|modified\|deleted", "patch": "<unified diff>"}]}` (code only, compares head snapshots) |
| GET | `/api/timelines/{id}/snapshots` | – | `{"snapshots": [Snapshot…]}` newest first |
| POST | `/api/timelines/{id}/snapshots` | `{"label"?}` | `201 Snapshot` (checkpoint of current state, live state if active) |
| POST | `/api/timelines/{id}/restore` | `{"snapshot_id"}` (must belong to this timeline) | `Timeline`. Head becomes a copy of that snapshot. If active, the runtime restarts on it. |
| GET | `/api/runtime` | – | `Runtime` |
| GET | `/api/runtime/logs` | query `tail` (default 200) | `{"lines": [str…]}` |
| GET | `/api/mutations` | – | `{"mutations": [{"kind", "description", "params_schema"}]}` |
| POST | `/api/dev/reset` | – | Wipes `.paradox/`, re-imports `demo_app/` as root, activates root. Returns `{"active_id": "root", "runtime"}`. For demos and tests. |

### Semantics the frontend can rely on
1. **Isolation.** Whatever happens in a timeline (likes, new posts, code edits) is invisible to its parent, siblings, and children that already exist.
2. **Persistence on leave.** Switching away autosaves the live DB and code into the timeline's head. Switching back restores it exactly.
3. **Sprout copies the parent's *current* state** (including unsaved live interactions if the parent is active), then applies the mutation.
4. The iframe URL never changes. After any call that returns a `runtime`, reload the iframe.
5. The demo app shows its timeline at `GET {runtime.url}/healthz` → `{"ok": true, "timeline_id": "..."}`, so the frontend can check it's showing the right future.

---

## Demo app contract (what the engine relies on)

Location: `demo_app/`. It's a Python package `app` (so `demo_app/app/main.py` exposes FastAPI `app`).

- Launched by the engine with cwd = workspace root (a copy of `demo_app/`):
  `python -m uvicorn app.main:app --host 127.0.0.1 --port $PARADOX_APP_PORT`
- Env: `APP_DB_PATH` (SQLite file path), `PARADOX_TIMELINE_ID` (string, default `"standalone"`), `PYTHONDONTWRITEBYTECODE=1`.
- On startup: `CREATE TABLE IF NOT EXISTS …` and seed deterministic data **only if empty**.
- Opens a new SQLite connection per request (no long-lived connection, no WAL mode). That keeps DB snapshots safe.
- **Mutation seam:** `app/feed.py` defines `STRATEGY: str` and `rank(posts: list[dict]) -> list[dict]`. All feed ordering goes through it. Posts are dicts with `id, author, body, likes, created_at`.
- Endpoints:
  - `GET /healthz` → `{"ok": true, "timeline_id": "<env>"}`
  - `GET /api/feed` → `{"strategy": "<feed.STRATEGY>", "timeline_id": "...", "posts": [Post…]}`
  - `GET /api/posts/{id}` → `Post` | 404
  - `POST /api/posts` `{"author", "body"}` → `201 Post` (likes 0, created_at now)
  - `POST /api/posts/{id}/like` → `Post` (likes+1)
  - `GET /` → self-contained HTML/vanilla JS feed UI (compose box, like buttons, strategy + timeline badge)
- All responses send `Cache-Control: no-store`.
- Post: `{"id": 1, "author": "ada", "body": "…", "likes": 12, "created_at": "2026-10-20T14:00:00Z"}`
- The seed data must make chronological, popularity, and hot orderings all **differ**, so tests can tell them apart.
