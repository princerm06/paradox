# Fork engine API — milestones 1 and 2

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

# Fork milestone 2 contract: AI-generated futures

**Status: approved 2026-10-23, frozen.** It's additive. Every milestone 1 endpoint and field in `docs/api-contract.md` keeps its current shape.
Breaking changes need the human's approval. Codex 1 copies this into `docs/api-contract.md` when the endpoints ship.

Base URL is configurable (default `http://127.0.0.1:8000`). JSON everywhere, except `/diff`, which returns `text/plain`.
Errors keep the milestone 1 shape `{ "detail": "message" }`.

---

## 0. Safe local development (M2.0: ship before generation)

| Env var | Default | Meaning |
|---|---|---|
| `PARADOX_CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173` | Comma-separated **exact** origins. `*` is rejected at startup. |
| `PARADOX_TOKEN` | unset | If set, every **mutating** `/api/*` request (POST/PUT/PATCH/DELETE) must send `Authorization: Bearer <token>`. Otherwise the engine returns **401** `{ "detail": "Missing or invalid token" }`, compared in constant time. GET requests and `/app/*` proxy traffic don't need it. |
| `PARADOX_APP_URL` | derived from the request | Absolute public iframe URL. Already shipped in milestone 1. |
| `PARADOX_AGENT` | `droid` | Default agent provider for generations. |
| `PARADOX_SCRIPTED_RECIPES` | `tests/fixtures/scripted_agent` | Recipe dir for the `scripted` provider. |

- CORS allows methods `GET, POST, OPTIONS` and headers `Content-Type, Authorization`.
- New launcher: `python -m engine [--host 127.0.0.1] [--port 8000]`. It **refuses to start on a non-loopback host unless `PARADOX_TOKEN` is set.** `uvicorn engine.api:app` keeps working for local use.
- Frontend: when a token is configured, send `Authorization: Bearer <token>` on every POST. Sending it on GET requests too is harmless.

## 1. Timeline additions (milestone 1 fields unchanged)
```json
{ "…milestone 1 fields…": "…", "modification": "ai", "generation_id": "uuid" }
```
- `generation_id` is `null` for non-AI timelines.
- AI timelines have `modification: "ai"`. They are created `pending` and use the existing activate, confirm, decline and restore endpoints unchanged.

## 2. Endpoints

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/agents` | — | `200 { "default": "droid", "providers": [Provider] }` |
| POST | `/api/generations` | GenerationRequest | `202` Generation (status `queued`) |
| GET | `/api/generations` | query `parent_id?` | `200 { "generations": [Generation] }`, newest first |
| GET | `/api/generations/{id}` | — | `200` Generation |
| GET | `/api/generations/{id}/logs` | query `stream=agent\|validation` (default `agent`), `tail` (default 200, max 2000) | `200 { "stream": "agent", "lines": ["…"] }` |
| GET | `/api/generations/{id}/diff` | — | `200 text/plain` unified diff against the parent's base snapshot. Empty body if there were no changes |
| POST | `/api/generations/{id}/cancel` | — | `200` Generation (status `cancelled`). **409** if already terminal |

Errors:
- 404: unknown generation or `parent_id`.
- 409: `parent_id` is declined.
- 422: invalid body, or the provider is unavailable, e.g. `{ "detail": "Agent provider 'droid' is unavailable: droid CLI not found on PATH" }`. An unavailable provider is rejected up front; it never becomes a failed generation.
- 401: missing token, when `PARADOX_TOKEN` is set.

### GenerationRequest
```json
{
  "parent_id": "uuid",
  "prompt": "Rank the feed by popularity",
  "name": "Popularity (AI)",
  "provider": "droid",
  "activate_on_success": false
}
```
- `prompt`: 1–4000 chars, required.
- `parent_id`: required.
- `name`: optional, 1–120 chars. Defaults to the first 60 chars of `prompt`.
- `provider`: optional, defaults to `PARADOX_AGENT`. One of `"droid" | "scripted" | "claude"`.
- `activate_on_success`: optional, default `false`.

### Provider
```json
{ "id": "droid", "available": false, "reason": "droid CLI not found on PATH" }
```
`reason` is `null` when the provider is available.

### Generation
```json
{
  "id": "uuid",
  "parent_id": "uuid",
  "name": "Popularity (AI)",
  "prompt": "Rank the feed by popularity",
  "provider": "droid",
  "status": "succeeded",
  "timeline_id": "uuid",
  "base_snapshot_id": "uuid",
  "activate_on_success": false,
  "created_at": "2026-10-24T01:00:00+00:00",
  "updated_at": "2026-10-24T01:01:10+00:00",
  "finished_at": "2026-10-24T01:01:10+00:00",
  "agent": {
    "exit_code": 0,
    "session_id": "abc123",
    "duration_ms": 41200,
    "summary": "Replaced chronological ranking with likes-descending…",
    "usage": { "input_tokens": 12000, "output_tokens": 900, "factory_credits": 0.4 }
  },
  "changes": {
    "files": [ { "path": "demo_app/ranking.py", "status": "modified", "additions": 4, "deletions": 2 } ]
  },
  "evaluation": {
    "passed": true,
    "checks": [
      { "name": "agent",   "status": "passed", "duration_ms": 41200, "detail": null },
      { "name": "guard",   "status": "passed", "duration_ms": 3,     "detail": null },
      { "name": "compile", "status": "passed", "duration_ms": 120,   "detail": null },
      { "name": "tests",   "status": "passed", "duration_ms": 2100,  "detail": "13 passed" },
      { "name": "boot",    "status": "passed", "duration_ms": 480,   "detail": null },
      { "name": "smoke",   "status": "passed", "duration_ms": 15,    "detail": "GET /health 200, GET /api/posts 200" }
    ],
    "tests": { "passed": 13, "failed": 0, "errors": 0 },
    "boot_ms": 480
  },
  "error": null
}
```

**Field rules:**
- `status` goes `queued → preparing → generating → validating → succeeded | failed | cancelled`. The last three are terminal.
- `timeline_id` is non-null **only** when `succeeded`.
- `base_snapshot_id` is set once `preparing` finishes; before that it's `null`.
- `finished_at` is `null` until the generation is terminal.
- `agent`, `changes` and `evaluation` are `null` until their stage has run. Checks that never ran are omitted.
- `usage` fields may be `null` when the provider doesn't report them.
- `error` is `null`, or `{ "stage": "prepare|agent|guard|compile|tests|boot|smoke|adopt|engine", "message": "…" }` when `failed` or `cancelled`.
- `stage: "engine"` means the engine restarted mid-run.
- Fixed check order: `agent, guard, compile, tests, boot, smoke`. The first failure stops the run. `evaluation.passed` is true only when all six passed.

**Frontend integration:**
- Poll `GET /api/generations/{id}` about every 1s until the status is terminal. On `succeeded`, refetch `/api/timelines`.
- Draw any generation whose status isn't `succeeded` as a ghost node under `parent_id`; draw it red when `failed`.
- An AI timeline's inspector can fetch `/api/generations/{generation_id}`, `/diff` and `/logs`.

## 3. Lifecycle and guarantees
1. **prepare** (holds the gate briefly).
   - If the parent is active, checkpoint its live state, using the milestone 1 stop → snapshot → start.
   - Copy the parent's **head snapshot** to `<state>/generations/<id>/workspace/{code,state}`, and record `base_snapshot_id`.
2. **agent** (no gate).
   - Run the provider with `cwd = …/workspace/code`, a timeout (default 300s), and a scrubbed environment: `PATH`, `HOME` and the provider's own key only.
   - The prompt goes in through a file or stdin, never into a shell command.
   - The engine wraps the user prompt with fixed instructions: read `demo_app/AGENTS.md`, change only `demo_app/`, add a test, don't modify existing tests.
3. **guard.** Fail if any of these hold:
   - no files changed
   - a change outside `demo_app/`
   - any symlink
   - a file over 256 KB, or more than 50 changed files
   - any file that existed under `demo_app/tests/` in the base was changed or deleted
   - `demo_app/AGENTS.md` was changed
4. **compile:** `python -m compileall -q demo_app`.
5. **tests:**
   - Command: `python -m pytest -q -p no:cacheprovider -c /dev/null --rootdir <code> demo_app/tests`, or an equivalent that ignores any outer pytest config
   - Runs in `<code>` with a scrubbed environment and a 120s timeout.
   - The parsed counts go into `evaluation.tests`.
6. **boot + smoke.**
   - Start a throwaway `Runtime` on port 0 against a **copy** of the base state.
   - Check that `GET /health` and `GET /api/posts` return 200, then stop it.
   - Validation never writes to the state that gets adopted.
7. **adopt** (holds the gate).
   - The new snapshot is the generated code plus the **unmodified** base state.
   - Create the timeline as `pending`, with `modification: "ai"` and `generation_id` set.
   - Activate it if `activate_on_success`.

**Guarantees:**
- The parent timeline, its snapshots, the source `demo_app/` and the live runtime are never modified by a generation. A failed or cancelled generation creates **no** timeline.
- Up to **2** generations run at once; extra requests wait as `queued`. Activate, sprout and proxy traffic keep working while generations run.
- On engine restart, any generation that wasn't terminal becomes `failed` with `stage: "engine"`.
- Generation records, logs and the generation folder persist for inspection.

## 4. Providers
| id | How | Notes |
|---|---|---|
| `droid` | **Official Factory Droid TypeScript SDK** (`@factory/droid-sdk@0.10.0`, `createSession` + `session.stream`) run by `engine/droid_adapter/dist/adapter.js` | `AutonomyLevel.Off`, non-file tools disabled, permission handler approves only edits under `<cwd>/demo_app`. Node ≥20, `npm ci && npm run build` in the adapter dir, SDK-required `droid` binary and `FACTORY_API_KEY`. Independently validated by the engine. |
| `scripted` | Deterministic, offline. Applies a recipe JSON from `PARADOX_SCRIPTED_RECIPES` | Used by tests and demo rehearsals. |
| `claude` | Optional fallback, not enabled | Advertised unavailable with a reason; requests return 422. |

### 4.1 Droid SDK adapter interface (engine ↔ Node, internal)
- **Launch:** `node engine/droid_adapter/dist/adapter.js`, cwd is the scratch code directory. A 300-second deadline sends SIGTERM before process-group kill after one second. Parent-death watchdogs kill orphaned process groups if the engine crashes.
- **stdin:** one JSON object: `{"cwd":"<abs code dir>","prompt":"<wrapped prompt>"}`.
- **stdout:** JSON Lines:
  - `{"type":"log","message":"…"}`, which goes to the `agent` log stream
  - exactly one final `{"type":"result","exit_code":0,"session_id":"…","summary":"…","usage":{"input_tokens":0,"output_tokens":0,"factory_credits":null}}`
- **Exit codes:**

  | Code | Meaning |
  |---|---|
  | 0 | SDK result was successful |
  | 1 | Agent or SDK execution failed |
  | 2 | Bad input or missing key |
  | 3 | SDK or SDK-required CLI unavailable |
  | 130 | Interrupted |

- **Environment:** `PATH`, `HOME` and `FACTORY_API_KEY` only. The key is never logged.
- **Mapping to the Generation API:**

  | Generation field | Adapter source |
  |---|---|
  | `agent.exit_code` | `exit_code`, overridden by a nonzero process exit |
  | `agent.session_id` | `session_id` from the SDK session |
  | `agent.duration_ms` | Measured by Python |
  | `agent.summary` | `summary` from the SDK result text |
  | `agent.usage` | `usage`, mapped from `tokenUsage.{inputTokens, outputTokens, factoryCredits}` |

  Missing session, summary, and usage values are nullable. Nonzero exits fail with `error.stage = "agent"`.
- **`/api/agents`:** `droid.available` requires Node ≥20, the adapter's dependencies installed, the `droid` CLI on PATH, and `FACTORY_API_KEY`. Otherwise `reason` names the first thing missing.
- **Probe:** `node dist/adapter.js --probe` checks SDK import and CLI availability without credentials or network.
- **Limits:** SDK reads cannot be restricted to the workspace, and its tool block is subtractive. This is trusted local development, not a sandbox. Live authenticated SDK validation is pending credentials and the SDK-required binary.
- **Source configuration:** `PARADOX_SOURCE_DIR` optionally selects a trusted demo source; explicit `create_app(runtime_source=...)` takes precedence. Validation always uses copies and the current Python interpreter (3.9 supported).

### Scripted recipe format (Codex 2 owns the recipes, Codex 1 owns the loader)
`<PARADOX_SCRIPTED_RECIPES>/<name>.json`:
```json
{ "match": "popular", "delay_s": 0, "summary": "…", "files": { "demo_app/ranking.py": "<full content>", "demo_app/old.py": null } }
```
- Paths are relative to the code dir, and `null` deletes the file.
- The **first** recipe in filename order whose `match` appears case-insensitively in the prompt wins.
- If no recipe matches, the run fails at `stage: "agent"`.

**Required recipes:**

| file | match | effect | expected result |
|---|---|---|---|
| `popular_feed.json` | `popular` | Popularity `ranking.py` plus a new test | `succeeded` |
| `broken.json` | `break the app` | `ranking.py` with a syntax error | `failed`, stage `compile` |
| `failing_test.json` | `failing test` | Valid code plus a new test that fails | `failed`, stage `tests` |
| `delete_test.json` | `delete a test` | Deletes an existing file in `demo_app/tests/` | `failed`, stage `guard` |
| `slow.json` | `slow` | `delay_s: 5`, harmless valid change | `succeeded` |

## 5. Security scope (read this)
- **A scratch directory is not a sandbox.**
  - Agents can read any file your user can read.
  - Generated code runs during compile, test and boot as your OS user, with network access.
  - Isolation only limits what we *adopt*. It doesn't contain what runs.
- **Running untrusted code is out of scope for the MVP.** Only run Fork on your own machine, with your own trusted prompts and repositories.
- **What we do provide:**
  - edit-only agent autonomy and scrubbed environments
  - timeouts and process-group kills
  - loopback-only runtimes
  - the guard checks
  - token auth for mutating calls
  - a launcher that won't bind beyond loopback without a token
- **Stretch goals:** macOS `sandbox-exec` or a container for validation, and a network-deny profile.
