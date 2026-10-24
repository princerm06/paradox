# Fork demo application: coding-agent instructions

## Scope and safety

- Work only inside `demo_app/` in the provided working directory. It is a copy
  of an existing application, not the engine's repository or live runtime.
- Treat the feature request as trusted local development, not permission to
  inspect secrets, other directories, credentials, or external services.
- Do not run shell commands, install dependencies, use the network, or write Git
  metadata. The engine independently compiles, tests, and boots your changes.
- Preserve this `AGENTS.md` and every file already present in `demo_app/tests/`
  byte-for-byte. Never delete, rename, weaken, skip, or rewrite existing tests.
- Add a new `demo_app/tests/test_<feature>.py` covering the requested behavior.
  Tests must be deterministic, fast, offline, and use only installed dependencies.
- Keep files below 256 KB, change at most 50 files, and do not create symlinks.

## Application and compatibility

The app is Python 3.9+, FastAPI, and SQLite. `main.py` exports `app` and
`create_app(app_dir=...)`. `PARADOX_APP_DIR` points to persistent state containing
`app.sqlite3`. Never use a real/live state directory from tests: call
`create_app(tmp_path)` inside a lifespan-enabled `fastapi.testclient.TestClient`.

Preserve existing contracts unless the feature explicitly adds compatible fields
or endpoints:

- `GET /` serves the demo HTML; use relative API URLs so `/app/` proxying works.
- `GET /health` and `/api/health` return status `ok` and the ranking label.
- `GET /api/posts` returns `{ "posts": [Post], "ordering": "..." }`.
- `POST /api/posts` accepts `author` and `content`, returns a Post with 201.
- `POST /api/posts/{id}/like` atomically increments likes, or returns 404.
- Post fields are `id`, `author`, `content`, `likes`, `created_at`. Preserve the
  SQLite schema and existing data. Do not reset/reseed an existing database.
- Keep parameterized SQL, validation of nonempty author/content, per-request
  closed connections, transactional writes, and DELETE journaling (not WAL).
- No new services, authentication requirements, credentials, or dependencies.

## Ranking implementation

`ranking.py` is the source of ranking behavior. It exports:

```python
ORDERING = "chronological"


def rank(posts: list[dict]) -> list[dict]:
    return sorted(posts, key=lambda post: (post["created_at"], post["id"]), reverse=True)
```

For a popularity feature, replace this implementation with `ORDERING = "popular"`
and sort by `(likes, created_at, id)` descending. Do not toggle `behavior.json` or
put a second sorting algorithm in `main.py`. That legacy config does not control
ranking. `rank` returns a new list containing the same posts, without mutating
the input list or its dictionaries. Ties must be deterministic; handle empty
input. A runtime restart loads the new source module.

## Validation and tests

The engine runs this from the copied code directory, using its current Python:

```sh
python -m compileall -q demo_app
python -m pytest -q -p no:cacheprovider -c /dev/null --rootdir "$PWD" demo_app/tests --junitxml /outside-code/tests.xml
```

Pytest plugin autoload is disabled. Do not depend on root pytest config, engine
imports, files outside `demo_app/`, Factory credentials, sockets, sleeps, or timing
thresholds. Tests may import the demo, FastAPI/TestClient, pytest, and the Python
standard library. Use fixed fixtures and temporary state; persistence/restoration
tests must stop the app before backing up or restoring SQLite. Do not change
process-global environment variables from application code or write test reports
into the app. Existing tests protect API/data integrity for both chronological
and popular ranking. New tests should prove the requested feature specifically.

Finish with a short summary of the changed behavior and added tests. The engine
owns validation/adoption; do not claim success based only on editing files.
