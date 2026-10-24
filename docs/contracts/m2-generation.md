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
| `droid` | `droid exec --auto low -o json --cwd <code>`, prompt via file/stdin | Edit-only autonomy: no commands, installs or git writes. Exit code 0 doesn't mean success, so we validate ourselves. Needs the `droid` CLI and `FACTORY_API_KEY`. A Droid SDK adapter may replace this later under the same id, without any API change. |
| `scripted` | Deterministic, offline. Applies a recipe JSON from `PARADOX_SCRIPTED_RECIPES` | Used by tests and demo rehearsals. |
| `claude` | `claude -p --output-format json --permission-mode acceptEdits --allowedTools "Read,Edit,Write,Glob,Grep"` | Optional fallback. |

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
