# Paradox

An interactive software time machine. Explore, test, and navigate alternate futures of your applications.

Paradox runs your app, lets you **sprout** a child timeline from any point, change it, and switch between timelines.
Each timeline keeps its own code **and** database state. You can confirm or decline each future.
Every future is a real, running version of the app, not a mockup.

## How the Factory Droid SDK powers AI-generated futures

You describe a change in plain English ("rank the feed by popularity"). Fork sprouts an *AI-generated future*, and the
**official [Factory Droid TypeScript SDK](https://github.com/Factory-AI/droid-sdk-typescript) (`@factory/droid-sdk`)** writes the code for it:

```
POST /api/generations {parent_id, prompt}
  │
  ├─ 1. prepare   Fork copies the parent timeline's code and SQLite state into a scratch workspace
  ├─ 2. agent     engine/droid_adapter (Node) → createSession({cwd, disabledToolIds, permissionHandler})
  │                └─ session.stream(prompt): Droid reads demo_app/AGENTS.md and edits the code; events stream into Fork's logs
  ├─ 3. guard     only demo_app/ may change, and existing tests can't be edited or deleted
  ├─ 4. validate  compile → the app's test suite → boot the future on a copy of the parent's data → smoke-test its HTTP API
  └─ 5. adopt     if every check passes, the result becomes a new pending timeline you can activate, inspect, confirm or decline
```

- **The SDK does the actual coding.** The Python engine starts the Node adapter and talks to it over a small JSON stdin / JSONL stdout
  interface (`docs/contracts/m2-generation.md` §4.1; adapter internals are in `engine/droid_adapter/README.md`). The adapter opens a Droid session in the future's workspace, streams it,
  and returns the SDK's result to Paradox.
- **Every future records Droid's provenance.** That's the SDK `sessionId`, run duration, Droid's summary, token usage and
  Factory credits, the full event log, the code diff, and Fork's evaluation (`GET /api/generations/{id}`, `/logs`, `/diff`).
- **Guardrails come from the SDK's own permission model.** Non-file tools are removed with `disabledToolIds`, and a
  `permissionHandler` only approves file edits under `demo_app/`. So Droid can't run commands, browse, spawn agents or push. Fork runs the tests itself and never trusts the
  agent's own claim of success.
- **Failed futures never touch the original.** If Droid's code doesn't compile, fails tests or won't boot, no timeline is created.
  The failure, logs and diff stay inspectable, and the parent timeline is unchanged.
- **A deterministic `scripted` provider** gives the same lifecycle offline, for tests and demo rehearsals.

### Setup

```sh
python3 -m venv .venv && .venv/bin/pip install -e '.[test]'
curl -fsSL https://app.factory.ai/cli | sh          # Droid CLI; the SDK spawns it
export FACTORY_API_KEY=fk-...                         # Factory settings → API keys
(cd engine/droid_adapter && npm ci --ignore-scripts && npm run build)   # @factory/droid-sdk (Node ≥ 20)
.venv/bin/python -m engine                            # http://127.0.0.1:8000, the app at /app/
curl -s localhost:8000/api/agents                     # "droid" should report available: true
```

## Docs

- API (milestone 1): `docs/api-contract.md`
- AI generation (milestone 2): `docs/contracts/m2-generation.md`
- Architecture: `docs/architecture.md`
- Tests: `.venv/bin/python -m pytest -q` (the engine, demo app and out-of-process acceptance tests in `tests/e2e/`)

## Security scope

Fork is a **local developer tool for your own code and prompts**.
- A generation workspace is a scratch directory, **not a sandbox**.
- Droid can read files your user can read.
- Generated code runs during validation as your OS user, with network access.
- Running untrusted code is out of scope.
- Keep the engine on loopback. To share it, set `PARADOX_TOKEN`; mutating API calls then require `Authorization: Bearer <token>`.
