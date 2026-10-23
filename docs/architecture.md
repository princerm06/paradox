# Paradox Architecture — Milestone 1 (timeline engine)

```
 Paradox frontend (owned by the user)  ──HTTP──▶  Engine (FastAPI :8000)  ──manages──▶  ONE app runtime (:8100)
          │ iframe                                  │                                     │ cwd = .paradox/runtime/workspace
          └──────────────────────────────────────────────────────────────────────────────▶ APP_DB_PATH = .paradox/runtime/app.db
```

## Repo layout & ownership (agents must not edit outside their area)
| Path | Owner |
|---|---|
| `docs/`, `.gitignore`, `requirements-dev.txt`, root `Makefile`/scripts | Claude (architect/integrator) |
| `engine/paradox_engine/**`, `engine/tests/**` | Codex 1 |
| `demo_app/**` (incl. `demo_app/tests/**`), `tests/integration/**` | Codex 2 |

Shared venv: `.venv` (Python **3.9**, so use `from __future__ import annotations` and `typing.Optional`/`List`, no `match`, no `X | Y` at runtime).

## Engine storage (`PARADOX_HOME`, default `<repo>/.paradox`)
```
.paradox/
  state.json              # timelines + snapshots + active_id. Written atomically (tmp + os.replace)
  code.git/               # private bare git repo; one commit per snapshot, refs/paradox/<timeline_id>
  snapshots/<snap_id>.db  # SQLite file per snapshot (made with sqlite3 backup API)
  runtime/workspace/      # the ONE work tree the app runs from
  runtime/app.db          # the ONE live DB
  runtime/app.log         # app stdout/stderr
  runtime/app.pid
```
Git is run as `git --git-dir=.paradox/code.git --work-tree=.paradox/runtime/workspace ...` with fixed author/committer env, so it never touches the user's repo or global config. `info/exclude` ignores `__pycache__/`, `*.pyc`, `*.db*`.

## Core operations
- **save_live(tl)** (active timeline only): stop app → `git add -A && commit` workspace → backup `runtime/app.db` → new `autosave` snapshot → `tl.head = snap`.
- **materialize(snap)**: stop app → make workspace exactly equal to `snap.code_ref` (tracked files replaced, extra files deleted, `__pycache__` purged) → copy snapshot DB to `runtime/app.db` (delete stale `-wal`/`-shm`/`-journal`) → start app with `PARADOX_TIMELINE_ID` → wait for `/healthz` to report that id.
- **activate(B)**: if B active → no-op. Else `save_live(A)`, `materialize(B.head)`, `active = B`.
- **sprout(P, mutation)**: if P active → `save_live(P)`. Materialize P.head's code into a scratch work tree (or the runtime workspace if activating), apply the mutation, commit → child `origin` snapshot (DB = copy of P.head DB) → `child.head = origin`. If `activate`, then `activate(child)`.
- **restore(T, snap)**: new snapshot copying `snap` (code_ref reused, DB file copied) → `T.head = it`. If T active → materialize.
- Everything that mutates state runs under one process-wide lock.

## Isolation hazards (must be covered by tests)
1. **Stale bytecode.** Restored `feed.py` could load an old `.pyc` with matching mtime/size. Fix: `PYTHONDONTWRITEBYTECODE=1` + purge `__pycache__` on materialize.
2. **SQLite sidecars.** `-wal`/`-journal` left over from another timeline corrupt or mix states. Fix: stop app first, use backup API, delete sidecars on restore. The app must not enable WAL.
3. **Lost live state.** Interactions in the active timeline only exist in `runtime/app.db` until saved. Every leave or sprout must `save_live` first.
4. **Snapshot aliasing.** Two timelines must never share a mutable DB file. Snapshots are immutable once written. Heads move by creating new snapshots, never by editing existing ones.
5. **Untracked or deleted files leaking.** A file added in child C must not exist after switching to the parent. A file deleted in C must reappear in the parent.
6. **Old process still bound to the port.** Kill the whole process group (start with `start_new_session=True`), wait for exit, and confirm the port is free before starting. Health check must verify `timeline_id` so we never accept the *old* server's response.
7. **Browser caching.** The app sends `Cache-Control: no-store`, and the frontend reloads the iframe after transitions.
8. **Engine restart.** On boot, load `state.json`. Kill any stale pid from `app.pid`. Treat `runtime/` as the active timeline's live state if present, then start the app.

## Out of scope for milestone 1
AI code generation (Factory Droid later plugs in as a `write_files`-style mutation producer), telemetry, comparisons, auth.
