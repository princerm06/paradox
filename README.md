# Paradox

**Explore alternate futures of your software before committing to one.**

Paradox is a Cal Hacks 13.0 developer-tool prototype built around executable timelines: create an alternative implementation, validate it, inspect the code and test evidence, preview the running application, and decide whether to activate, confirm, or decline it. A timeline has its own application code and SQLite state, so you can compare behavior without overwriting the original.

- [Watch the 2:55 demo](https://vimeo.com/1239218495)
- [Studio interface and tests](apps/studio/README.md)
- [Engine architecture](docs/architecture.md)

## What the prototype demonstrates

- **Explore:** A visual timeline graph, live application portal, generation composer, and per-future inspector. Inspecting a future does **not** activate it.
- **Generate:** Start a candidate future from a chosen parent. The engine records progress, cancellation, provenance, logs and diffs. An offline `scripted` provider supports deterministic rehearsals; a separate Factory Droid provider uses the official TypeScript SDK when its prerequisites and credentials are configured.
- **Validate:** Guard the edit scope and run compilation, tests, application boot and HTTP smoke checks before adopting a successful generated future. Failed attempts remain inspectable without creating an adopted timeline.
- **Compare:** Inspect two futures or attempts side by side, including validation checks, changed files, per-base diffs and logs. This is **not** a direct A-versus-B source diff or a GPU/runtime benchmarking system.
- **Manage:** Activate, confirm, decline, snapshot and restore timelines, with explicit confirmation for state-changing Studio actions.
- **Architect:** Inspect an architecture view that distinguishes observed engine/API information, documented contracts and inferred file relationships. It is **not** a measured dependency graph.

The repository also includes experimental repository-import and macOS desktop work. These paths have separate readiness and security limitations; they should not be interpreted as generally released or production-hardened features.

## How Factory Droid fits

The Python engine launches the Node adapter in [`engine/droid_adapter`](engine/droid_adapter/README.md), which uses `@factory/droid-sdk` to edit a copied application workspace. The engine, not the agent's summary, evaluates the result. The adapter documents a scoped edit policy, mandatory macOS write restrictions, recorded live-verification evidence, and known limitations. See [verification evidence](engine/droid_adapter/VERIFICATION.md) for what was actually tested.

**Evidence distinction:** The scripted end-to-end path and mocked SDK tests are not evidence that every real Droid session will succeed. Recorded live Droid runs are documented separately. Neither the SDK integration nor the write sandbox makes arbitrary generated code safe to execute.

## Run the local prototype

Requirements: Python 3.9+, Node.js for the Studio, and a trusted local development environment.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[test]'
PARADOX_AGENT=scripted .venv/bin/python -m engine --host 127.0.0.1 --port 8000
```

In another terminal:

```sh
cd apps/studio
npm ci
npm run dev
```

Open `http://localhost:5173`. The engine is at `http://127.0.0.1:8000`. The scripted provider uses local recipes and does not require a Factory key. For Droid setup, see [adapter instructions](engine/droid_adapter/README.md). Never commit credentials.

## Tests and documentation

```sh
.venv/bin/python -m pytest -q
cd apps/studio && npm run typecheck && npm run lint && npm test && npm run build
```

These are commands to run locally, **not a claim that they were executed during this documentation update**. Browser E2E tests and their isolation rules are described in [Studio README](apps/studio/README.md).

- [Engine setup and configuration](engine/README.md)
- [API contract](docs/api-contract.md)
- [Generation contract](docs/contracts/m2-generation.md)
- [Validation limitations](docs/validation-hardening.md)
- [Desktop prototype release gate](apps/desktop/README.md)

## Security and release status

**Hackathon prototype / trusted local development only — not a production service or hostile-code sandbox.**

- Keep the engine bound to loopback; configure `PARADOX_TOKEN` for mutating API requests. The engine's direct Uvicorn entrypoint can bypass its launcher host check. Do not expose it publicly.
- Workspaces and validation are not complete security isolation. Generated application code and some test paths may execute with local-user privileges; the Droid adapter's macOS write restrictions do not confine reads or all network activity.
- Do not run untrusted repositories or prompts with sensitive credentials available. The experimental desktop Factory path documents an unresolved credential-exposure risk.
- Keep `.env` files, tokens, database state and other private material out of Git. Git ignore rules prevent accidental **new** additions, not exposure of previously committed files or historical secrets.
- A complete Git-history secret scan, dependency review, and independent security assessment are still required before any broader release.

This README describes the current prototype and explicitly separates implemented capabilities from limitations and experimental work.
