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

`PARADOX_APP_DIR` contains `app.sqlite3` and `behavior.json`. On first startup,
the demo copies its bundled `behavior.json` if no state configuration exists.
The baseline is `{"feed_order":"chronological"}`. The deterministic future sets
`feed_order` to `popular`; startup validates and loads it. Restart after changing
the configuration. Snapshot **both code and state**, not only the SQLite file.

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
python3 -m venv /tmp/paradox-demo-venv
/tmp/paradox-demo-venv/bin/python -m pip install -r requirements-demo.txt
PARADOX_APP_DIR=/tmp/paradox-demo-state /tmp/paradox-demo-venv/bin/python -m uvicorn demo_app.main:app --port 8001
```

Open `http://127.0.0.1:8001/`. To validate demo APIs alone:

```sh
/tmp/paradox-demo-venv/bin/python -m pytest tests/demo/test_demo_api.py -q
```

Once the engine is present, run `python -m pytest tests/demo/ -q` in the installed
environment. Integration tests use real child runtime processes behind the engine
proxy, with temporary state and dynamically selected ports. They exercise parent /
child / sibling isolation, writes and likes surviving traversal, checkpoint
restoration of actual Python source and HTML alongside SQLite data,
confirmation/decline, and restarting the whole engine. Each test's
lifespan shuts down its runtime. All tests and docs here belong to Codex 2; engine
implementation and root packaging remain owned by Codex 1.
