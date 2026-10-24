# Factory sponsor verification

## What is the official SDK integration?

Paradox pins **`@factory/droid-sdk` 0.10.0**, installed from the npm lockfile.
It is not an AI-shaped scripted demo and does not invoke `droid exec` directly.

The production call chain is:

1. `POST /api/generations` selects an explicit provider or `PARADOX_AGENT`
   (default `droid`). `Generations.run` checkpoints the parent and copies its
   code and SQLite state into a generation workspace.
2. `engine/providers.py` starts `node .../dist/adapter.js`. Its single stdin
   request contains the isolated code directory and wrapped feature prompt.
   Only the SDK subprocess receives `FACTORY_API_KEY`; validation does not.
3. `src/adapter.ts` dynamically imports **`@factory/droid-sdk/node`**, then calls
   **`createSession`** with `cwd`, **`AutonomyLevel.Off`**, **`disabledToolIds`**,
   **`permissionHandler`**, **`abortSignal`**, and disabled built-in skills.
4. It iterates **`session.stream(prompt, {abortSignal})`**. SDK messages become
   JSONL logs; the final result maps **`sessionId`**, **`tokenUsage.inputTokens`**,
   **`outputTokens`**, and **`factoryCredits`** into the Python result. It calls
   **`session.close()`** in `finally`, including failures/cancellation.
5. Python independently runs guard, compile, tests, boot, and HTTP smoke checks.
   Only successful validation publishes an AI timeline, atomically associated
   with its generation, using generated code and the original snapshot data.

The installed SDK implementation was inspected, not just its types:
`node_modules/@factory/droid-sdk/dist/node.mjs` defines `createSession`,
`DroidSession.stream`, and `createTransport`. `createTransport` uses the SDK's
`ProcessTransport` and sets `FACTORY_UPSTREAM_CLIENT_TYPE=sdk` and
`FACTORY_UPSTREAM_SDK`. It resolves credentials from `options.apiKey` or
`FACTORY_API_KEY`. The SDK itself launches the installed `droid` binary for its
JSON-RPC transport. That implementation detail does not make Paradox a
CLI-only integration: session creation, permissions, streaming, cancellation,
results, and usage all use the official SDK API.

A CLI login alone does not satisfy this SDK initialization path:
`createTransport` calls `resolveApiKey` before connecting. Do not bypass the
missing-key check with a placeholder or claim that a CLI installation proves
SDK authentication.

## Reproduce one real generation

Install Python dependencies, Node 20+, the Factory CLI, and securely configure
`FACTORY_API_KEY` in the invoking environment. Never paste it into a command,
fixture, prompt, report, or source file. From the repository root:

```sh
.venv/bin/python -m pip install -e '.[test]'
npm --prefix engine/droid_adapter ci
npm --prefix engine/droid_adapter run build
node engine/droid_adapter/dist/adapter.js --probe
.venv/bin/python -m engine.droid_adapter.verify_live \
  --state-dir .venv/droid-proof-unique
```

The final command makes **one** generation POST with provider **`droid`** and
the exact prompt:

> Rank the feed by popularity, most liked first. Add a test.

It starts a disposable engine on loopback/ephemeral ports and talks to it over
real HTTP, not direct manager calls. It refuses an existing state directory,
does not retry, and shuts down its engine. No request is submitted when
`/api/agents` says Droid is unavailable. It saves:

- `http-evidence.json`: availability, observed lifecycle states, generation
  response, SDK session/usage, logs, validation, timeline association, source
  hashes, and parent/child feeds.
- `http-diff.patch`: actual code diff obtained through the generation HTTP API.
- `generations/<id>/workspace/code/demo_app/`: actual generated source/tests.
- snapshots and databases proving an independently revisitable future.

A successful verifier requires changed `ranking.py`, an added test, passing
validation, and a nonempty real SDK session ID. It activates the child, checks
descending likes, writes/likes a child-only post, returns to the unchanged
chronological parent, and revisits the child with its write preserved. Parent
writes made after generation must not appear in the child. The source tree of
the original demo is never edited.

Use a new state directory for any intentional subsequent paid run. Do not run
the existing live acceptance test as an extra paid call merely to duplicate
this proof. That acceptance test accepts both `succeeded` and `failed`, so a
passing test alone is **not** proof of a validated alternate future.

## Availability and failure semantics

`GET /api/agents` checks executable/build/key prerequisites, Node version, and
the adapter's SDK-import/CLI probe. This does not authenticate with Factory or
spend credits. `available: true` means ready to attempt a run, not proof that
the key is valid, the account has credits, or the remote service is reachable.

- Missing Node, CLI, built adapter, key, dependencies, malformed probes, or a
  probe timeout report unavailable with a reason. Generation creation returns
  422 before queuing when the requested provider is unavailable.
- SDK authentication/session/turn errors produce `failed`, stage `agent`, an
  explicit redacted message, agent result where available, and no AI timeline.
- Missing, duplicate, or malformed adapter results fail closed. A successful
  adapter result requires a session ID and valid numeric usage metadata.
- The SDK has a 300-second deadline. Python terminates the process group with
  SIGTERM, allows a one-second grace window, then uses SIGKILL. A timeout is a
  failed agent stage; cancellation is terminal `cancelled`, never adoption.
- `scripted` remains available only when configured recipes exist. Selecting
  it explicitly (request `provider: "scripted"` or `PARADOX_AGENT=scripted`)
  is an offline rehearsal, **not** Factory evidence. Droid errors never
  silently select it.

Permission tests are not an OS sandbox. Read-only SDK tools are not path-scoped;
the denylist is subtractive and newer CLI tools require review. Generated code
and tests run as the local user. See the adapter README for the full boundary.

## Verification record

Audit date: October 23, 2026 (America/Los_Angeles).

Local raw artifacts live in the ignored `.venv/` proof directory; do not commit
credentials or raw private session data. At the prerequisite check:

```json
{
  "default": "droid",
  "providers": [
    {"id": "droid", "available": false, "reason": "FACTORY_API_KEY is not configured"},
    {"id": "scripted", "available": true, "reason": null},
    {"id": "claude", "available": false, "reason": "optional Claude provider is not enabled"}
  ]
}
```

No credential was present in this execution environment or its interactive
shell. The prerequisite verifier therefore **sent no generation POST**; no
paid call, real SDK session, generated future, or authenticated success is
claimed for this audit until the one-shot command runs with secure credential
injection. A reported earlier passing live test is separate evidence, not
substituted for the missing run.

Offline checks:

- `pytest tests/test_droid_provider.py -q`: **23 passed**. Includes precise
  availability errors, default/explicit Droid refusing fallback, SDK failure
  detail/redaction, malformed/duplicate results, timeout, cancellation, and
  the full verifier traversal using a deliberately fake adapter.
- `pytest tests/test_generations.py tests/test_droid_provider.py -q`:
  **44 passed** in 35.50 seconds.
- `npm --prefix engine/droid_adapter test`: **19 passed** with injected SDK
  mocks, including abort/close and stream-without-result failures.
- `env -u FACTORY_API_KEY .venv/bin/python -m pytest -q`: **132 passed,
  1 skipped** in 205.32 seconds. The live acceptance test is deliberately
  skipped by unsetting the key, preventing accidental extra paid requests.

These tests prove local behavior, not Factory authentication or agent quality.

Environment inspected: Python 3.9.6, Node 24.22.1, Factory CLI 0.249.0,
official SDK 0.10.0. The SDK import/CLI probe succeeded without a network call.
Dependency audit reported one moderate and two high advisories (SDK/transitive
uuid/zod); no forced SDK downgrade or dependency rewrite was performed.
