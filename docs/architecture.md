# Fork architecture — milestone 1

Fork (formerly Paradox) lets a developer sprout, switch between, confirm and decline alternate working futures of a running app. Each future has its own code **and** SQLite data. The HTTP contract lives in `docs/api-contract.md` (owned by Codex 1). This file explains how the pieces fit and what must stay true.

```
Frontend (human)  ──HTTP /api──▶  Engine (FastAPI :8000)  ──manages──▶  ONE app runtime (uvicorn, internal port)
      │ iframe app_url                │ /app/* proxy                        cwd   = workspace/code/
      └───────────────────────────────┘                                     state = workspace/state/ (app.sqlite3, behavior.json)
```

## Repository and ownership
| Path | Owner | Branch / worktree |
|---|---|---|
| `engine/`, `pyproject.toml`, `tests/test_engine*.py`, `docs/api-contract.md` | Codex 1 | `feat/engine` → `../paradox-worktrees/engine` |
| `demo_app/`, `tests/demo/`, `docs/demo-api.md`, `requirements-demo.txt` | Codex 2 | `feat/demo-app` → `../paradox-worktrees/demo-app` |
| `docs/architecture.md`, `tests/e2e/`, `.gitignore` | Claude | `chore/architecture` → `../paradox-worktrees/architecture` |
| `frontend/` | Human | (their own) |

- All feature branches merge by PR into `integration/m1`, then `integration/m1` merges into `main`. Nobody pushes directly to `main`.
- `baseline/m1` (4a3b55b) is the frozen pre-split state.
- Each worktree uses its **own** `.venv` (`pip install -e '.[test]'`). The shared checkout's `.venv` has an editable install pointing at the shared checkout, so other worktrees must not use it.

## Timeline model
- Metadata lives in `<state_dir>/engine.sqlite3`. This is engine-private and never snapshotted.
  - `timelines(id, parent_id, name, status, created_at, snapshot_id, modification)`
  - `snapshots(id, timeline_id, created_at)`
  - `settings(active_id, transition)`
- `snapshot_id` is the timeline's **head**, meaning its latest saved state.
- Snapshots are immutable and belong to exactly one timeline. Siblings never share a mutable file.
- Status goes `pending` → `confirmed` | `declined`. Root is `confirmed` and can't be declined.
- Decline does **not** cascade. Declining the active timeline moves to its nearest non-declined ancestor.
- `modification` is `null` for root, and `"popular_feed"` (or `null`/`"none"`) for sprouts.

## Snapshot strategy
- A snapshot is a full copy of `workspace/`: `code/demo_app/` + `state/`.
- **SQLite consistency:** stop the runtime and wait for it to exit, copy with `sqlite3.backup()`, then delete `-wal`/`-shm`/`-journal`. The demo app uses DELETE journaling and opens one connection per request, with no background writers.
- **Inheritance:** sprouting from the *active* parent checkpoints its live state first. Sprouting from an inactive parent (`parent_id`) starts from that parent's head. Then the child's code gets the modification and becomes the child's first snapshot.

## Deterministic modification (approved change A)
- The seam is `demo_app/ranking.py`, which exports `ORDERING: str` and `rank(posts: list[dict]) -> list[dict]`.
  - `rank` returns a new list and doesn't mutate its input.
  - The baseline orders by `created_at DESC, id DESC`.
- All feed ordering in `main.py` goes through it. The `/api/posts` response reports `ranking.ORDERING`.
- `popular_feed` overwrites `workspace/code/demo_app/ranking.py` with an engine-owned template.
  - It orders by `likes DESC`, then the same tie-breakers.
  - It sets `ORDERING = "popular"`.
- `behavior.json` is **not** the mechanism.
- The source `demo_app/` is never written by the engine.

## Activation and rollback
1. Take the gate. Transitions and proxied app traffic are serialized.
2. Stop the runtime and checkpoint the outgoing timeline. That snapshot is the rollback point.
3. Persist the `transition` marker (rollback snapshot id).
4. Restore the target into staging, then swap it in for `workspace/`. For a sprout, apply the modification here.
5. Start the runtime and wait for `/health`. Then set `active_id` and clear the marker in one metadata transaction.
6. On failure: stop, restore the rollback point, restart, keep the previous active timeline, and return 503.

Recovery:
- **Engine crash mid-transition:** on boot the marker is present, so the engine restores the rollback snapshot.
- **Engine crash outside a transition:** `workspace/` is the active timeline's live state and is kept as-is.
- **App crash:** `/api/health.runtime_running` turns false. Activating the active timeline restarts it on the untouched live state.
- **No orphans:** the runtime gets its listener as a pre-bound fd with `SO_REUSEADDR`, and runs in its own session. It exits when the engine's stdin pipe closes, so a hard-killed engine leaves nothing behind.

## Isolation invariants (each is asserted in `tests/e2e/`)
1. Writes in a timeline are invisible to its parent, siblings and existing children.
2. Leaving a timeline preserves its writes, and returning restores them exactly, including writes made after activation.
3. A sprout inherits the parent's state at sprout time, and nothing after.
4. The child's `ranking.py` differs from the parent's, and switching swaps it back. The source `demo_app/` is untouched.
5. Each switch restarts the runtime (new pid). Re-activating the active timeline doesn't restart it. Ten rapid switches all stay correct.
6. A runtime kill or engine kill (SIGKILL) loses no timelines and no live data.

## Frontend integration
- Iframe `app_url`. After change D this is absolute; it's configurable with `PARADOX_APP_URL`.
- After every mutating call: refetch `GET /api/timelines`, then reload the iframe with a cache-buster.
- Calls block for about 1–3s until the runtime is healthy. Animate during that time and disable controls, since calls serialize.
- Build the graph from `parent_id`. Exactly one timeline has `is_active: true`.
- Errors are `{detail: string}`: 404 unknown, 409 lifecycle conflict, 503 transition failed (previous timeline restored).
- CORS is configurable. The defaults allow `localhost`/`127.0.0.1` on 3000 and 5173 (frontend port not yet confirmed).

## Out of scope for milestone 1
AI code generation (Factory Droid), telemetry, timeline diff/compare, auth, sandboxing untrusted code.
