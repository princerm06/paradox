# Stateful demo app — Codex 2

The demo is a separate application, not the Paradox graph frontend. It provides
a minimal feed page so backend and database changes can be exercised immediately.
It has no dependency on the engine package.

## Agreed runtime boundary

Copy the entire `demo_app/` package into `workspace/code/demo_app/`. Launch from
`workspace/code/` with the same Python environment as the engine:

```sh
PARADOX_APP_DIR=/absolute/workspace/state python -m uvicorn demo_app.main:app --host 127.0.0.1 --port 8001
```

`PARADOX_APP_DIR` holds `app.sqlite3`. Feed implementation lives in the copied
`workspace/code/demo_app/ranking.py`, not database configuration. The old
`behavior.json` file is retained for compatibility with existing engine snapshots,
but the demo does not read it or create new copies. Changing `feed_order` in that
file no longer changes application behavior. Snapshot **both code and state**,
not only the SQLite file.

## Ranking interface for Codex 1

`demo_app/ranking.py` exports exactly these integration points:

```python
ORDERING = "chronological"


def rank(posts: list[dict]) -> list[dict]:
    return sorted(posts, key=lambda post: (post["created_at"], post["id"]), reverse=True)
```

The app selects unsorted SQLite rows, converts them into post dictionaries, and
passes the list through `ranking.rank`. There is no alternative SQL sorting path
or config-selected algorithm. The returned list supplies the feed unchanged;
`ranking.ORDERING` supplies both feed and health response labels. It must be
`chronological` or `popular`; an invalid label fails startup.

`rank` must return a new list containing the same posts without changing the
input list or its dictionaries. Each dictionary has the documented Post fields.
An empty input returns an empty list. Break timestamp ties using descending ID
to keep traversal and test results deterministic. Timestamps are normalized UTC
ISO strings written by the demo. `rank` must not access SQLite or external state.

For `popular_feed`, Codex 1 should stop the runtime, replace **only the working
copy** `workspace/code/demo_app/ranking.py` with the following module, and restart:

```python
ORDERING = "popular"


def rank(posts: list[dict]) -> list[dict]:
    return sorted(
        posts,
        key=lambda post: (post["likes"], post["created_at"], post["id"]),
        reverse=True,
    )
```

Do not edit the source template in the repository, the parent's snapshot, the
SQLite schema, or `behavior.json` to implement this future. A full process restart
loads the replaced module; do not use in-process module reloads. Disable bytecode
writes and purge copied/restored `__pycache__` so same-size source replacements
cannot reuse stale compiled code. The engine must snapshot this Python file as
part of code restoration, independently from database restoration.

Each request owns and closes its SQLite connection. Writes are transactional;
likes increment atomically. SQLite uses DELETE journaling, not WAL. The engine
must gate proxy requests, stop the runtime and wait for exit before taking or
restoring filesystem snapshots. Do not copy a live SQLite file. There are no
background writers, caches, external services, or global database connections.

## HTTP contract

| Method | Standalone path | Result |
| --- | --- | --- |
| GET | `/` | Minimal interactive feed page |
| GET | `/health` or `/api/health` | `{"status":"ok","ordering":"chronological"}` |
| GET | `/api/posts` | `{"posts":[Post],"ordering":"chronological"}` |
| POST | `/api/posts` | Post, 201 |
| POST | `/api/posts/{id}/like` | Updated Post, 200; missing post 404 |

Through the engine, prefix paths with `/app`: iframe `/app/`, feed
`/app/api/posts`. The HTML uses relative API URLs to work through that proxy.
Reload the iframe after switching timelines. These local-demo APIs intentionally
have no authentication, pagination, or rate limiting.

Post creation accepts `{"author":"Ada","content":"Hello"}`. Both fields are
trimmed and nonempty; limits are 80 and 2,000 characters respectively. Invalid
requests return 422. Post representation:

```json
{
  "id": 1,
  "author": "Ada",
  "content": "An older post the community loves.",
  "likes": 8,
  "created_at": "2026-01-01T12:00:00+00:00"
}
```

`ordering` is `chronological` or `popular`. Chronological sorts by timestamp
descending, then ID descending. Popular sorts by likes descending, then those
same tie breakers. The initial older post has 8 likes and the newer post has 1;
the ordering visibly reverses without needing extra interactions. Seeds are
inserted only when the posts table is first created; restart never reseeds it.

## Running independently

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-demo.txt
PARADOX_APP_DIR=/tmp/paradox-demo-state .venv/bin/python -m uvicorn demo_app.main:app --port 8001
```

Open `http://127.0.0.1:8001/`. To validate demo APIs alone:

```sh
.venv/bin/python -m pytest tests/demo/test_demo_api.py tests/demo/test_ranking.py tests/demo/test_runtime_restore.py -q
```

Once the engine is present, run `.venv/bin/python -m pytest tests/demo/ -q` in the installed
environment. Integration tests use real child runtime processes behind the engine
proxy, with temporary state and dynamically selected ports. They exercise parent /
child / sibling isolation, writes and likes surviving traversal, checkpoint
restoration of actual Python source and HTML alongside SQLite data,
confirmation/decline, and restarting the whole engine. Each test's
lifespan shuts down its runtime. All tests and docs here belong to Codex 2; engine
implementation and root packaging remain owned by Codex 1.

The standalone runtime restoration test copies the demo package into a temporary
workspace and starts real uvicorn processes from this environment. With unchanged
database rows it verifies chronological `[2, 1]` versus popular `[1, 2]`, persists a
new post and like through restart, restores a SQLite backup without reverting the
code implementation, then restores chronological source and checks the exact
original feed. It does not import or patch the engine. Existing engine integration
tests require Codex 1's source-replacement implementation of `popular_feed`; the
old behavior.json-only engine is intentionally no longer sufficient.
