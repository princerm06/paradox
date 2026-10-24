# Fork execution engine

Python 3.9 or newer, one engine worker, trusted local repositories/prompts only.
Generated tests and applications execute as your OS user; a copied workspace is
not a sandbox. HTTP schemas and lifecycle rules are in `docs/api-contract.md`.

## Run

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[test]'
.venv/bin/python -m engine --host 127.0.0.1 --port 8000
```

The launcher refuses non-loopback hosts unless `PARADOX_TOKEN` is set. An explicit
`uvicorn engine.api:app` launch bypasses this host safeguard; keep it on loopback.
Use one worker and do not run multiple engines against the same state directory.

Configuration:

- `PARADOX_STATE_DIR`: persistent timelines, snapshots, generation records/logs.
- `PARADOX_SOURCE_DIR`: trusted app source, default bundled `demo_app/`.
- `PARADOX_CORS_ORIGINS`: comma-separated exact origins; wildcard origins fail.
- `PARADOX_TOKEN`: optional bearer token required on mutating `/api/*` requests.
- `PARADOX_APP_URL`: public absolute iframe URL; default engine request origin.
- `PARADOX_AGENT`: `droid` by default, or `scripted` for offline rehearsals.
- `PARADOX_DROID_MODEL`: direct-tool SDK model, default `claude-sonnet-4-6`.
- `PARADOX_SCRIPTED_RECIPES`: recipe directory, default `tests/fixtures/scripted_agent`.

Set credentials privately in your local environment. Do not put keys or tokens in
source files, requests, recipe JSON, or command-line arguments. GET requests and
the `/app/` proxy remain unauthenticated by the frozen local-development contract.

## Official Factory SDK

```sh
cd engine/droid_adapter
npm ci
npm run build
npm test
node dist/adapter.js --probe
```

This is the official `@factory/droid-sdk` TypeScript integration, not a direct
`droid exec` subprocess. The SDK itself still requires the `droid` executable on
PATH. Node 20+, that binary, the built adapter and `FACTORY_API_KEY` must all be
available for `/api/agents` to enable Droid. Availability is a local prerequisite
check, not an authenticated service/credit check. See
`droid_adapter/VERIFICATION.md` for the official SDK call chain, test evidence,
and a one-paid-call HTTP verifier. See `droid_adapter/README.md` for limitations,
permission restrictions and dependency audit notices.

## Generation isolation and recovery

Two worker threads perform generation; additional jobs stay queued. Only prepare
and final adoption take the runtime gate. Compile/test commands use the current
Python, scrubbed environments and deadlines, and ignore outer pytest config and
plugin autoload. Validation state is disposable; adoption always uses the original
base snapshot's SQLite state. Tests may only add new files, not rewrite existing
app tests or `AGENTS.md`.

Generation records and timeline adoption share SQLite. A successful adoption
commits its timeline, snapshot and result together. Cancellation cannot publish a
timeline; status reads and cancellation remain responsive during runtime startup.
Nonterminal records become failed with stage `engine` after restart. Process-group
termination, a one-second graceful shutdown window, and parent-death pipes prevent
ordinary subprocesses from surviving cancellation or an engine crash. This does
not contain intentionally detached processes from untrusted code.

Logs and diffs remain in `<state>/generations/<id>/`. Log API responses redact
configured credentials. Restart the engine if adoption reports rollback failure;
the transition marker restores the previous committed timeline.

## Tests

```sh
.venv/bin/python -m pytest -q
```

The scripted end-to-end tests need Codex 2's M2 demo tests/recipes integrated.
No Factory credentials or network are required for scripted and mocked SDK tests.
