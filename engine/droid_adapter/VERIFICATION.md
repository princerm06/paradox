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
   It explicitly selects `modelId` (default `claude-sonnet-4-6`, override
   `PARADOX_DROID_MODEL`), checks the session's `toolExecutionMode`, and calls
   **`session.listTools`** before streaming. SDK **`listModels`** first checks
   availability and organization restrictions; the initialized model must match
   the requested ID. Read, Edit, and Create must each report `allowed === true`.
   Script-only/unknown-mode/disallowed-file-tool
   sessions fail closed rather than paying for a tool-less model response.
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

**Do not repeat the paid command below without fresh user approval.** The one
authorized run failed; the subsequent investigation and fixes are offline.

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

Initially no credential was present in this execution environment or its
interactive shell. The prerequisite verifier sent no generation POST. A later
user-authorized, privately configured run created the real session below; it
did **not** create a working future. No second paid run was made during the
investigation.

Offline checks:

- `tests/test_droid_provider.py`: **24 cases pass** in the full suite. Includes precise
  availability errors, default/explicit Droid refusing fallback, SDK failure
  detail/redaction, malformed/duplicate results, timeout, cancellation, and
  the full verifier traversal using a deliberately fake adapter.
- `pytest tests/test_generations.py tests/test_droid_provider.py -q`:
  **45 passed** in 34.96 seconds.
- `npm --prefix engine/droid_adapter test`: **23 passed** with injected SDK
  mocks, including abort/close and stream-without-result failures.
- `env -u FACTORY_API_KEY .venv/bin/python -m pytest -q`: **133 passed,
  1 skipped** in 204.17 seconds. The live acceptance test is deliberately
  skipped by unsetting the key, preventing accidental extra paid requests.

These tests prove local behavior, not Factory authentication or agent quality.

Environment inspected: Python 3.9.6, Node 24.22.1, Factory CLI 0.249.0,
official SDK 0.10.0. The SDK import/CLI probe succeeded without a network call.
Dependency audit reported one moderate and two high advisories (SDK/transitive
uuid/zod); no forced SDK downgrade or dependency rewrite was performed.

## Paid-run failure and offline fix

- Generation: `bd3c06b0-c092-4724-8fc0-e07def78261a`.
- Official SDK session: `c73bc85d-918f-4f68-bcaa-ae2a69d62f0c`.
- Saved HTTP proof: `.venv/droid-proof-1/http-evidence.json`.
- Result: SDK exit 0, followed by generation `failed`, stage `guard`,
  `Agent made no code changes`; diff/files empty, no timeline adopted.
- Reported cost: **5,222 Factory credits**, from the saved SDK usage result
  (`factory_credits: 5222`); this paid run was not a successful generation.
- Observed HTTP statuses: queued, preparing, generating, failed. Validating
  was transient and was not observed by polling; the stored evaluation includes
  the passed agent check and failed guard check.

The real agent explicitly said it had no file-reading/editing tools and made
no changes. `agent.log` has session-start, assistant, and result records, but
**zero tool calls, tool results, or permission decisions**. The persisted
Factory session JSONL likewise has no tool calls. There is no evidence of the
permission handler blocking a requested write: it was never called.
An independent SHA-256 comparison found all 12 base/future source files
identical. The unchanged `demo_app/ranking.py` hash is
`705db40a9de900fa28c27bb1d393857d18c1659221b4d549811f98ac0e7f8936`.
Adapter output contains two log records and one result; timeline association
is null. These checks corroborate the guard rather than weakening it.

The persisted session settings identify the mismatch:

```json
{
  "model": "gpt-6.1-sol",
  "toolExecutionMode": "script_only",
  "toolExecutionModeModelId": "gpt-6.1-sol",
  "autonomyLevel": "off"
}
```

The adapter disabled `Script` and `WaitForScript`, intentionally, along with
`Execute`. In a `script_only` session, native tools are reached through Script;
removing that bridge leaves the model unable to call file tools. The installed
SDK defines `ToolExecutionMode` as controlling direct versus Script-only tool
exposure. The saved session's system reminder also instructs the agent to load
tools through Script. This is an **adapter configuration incompatibility**, not
a wrong directory, broken SDK transport, fabricated no-edit result, or
insufficiently explicit prompt.

The saved `cwd` is exactly the generation's isolated
`generations/<id>/workspace/code`, not the parent workspace or repository.
Its saved user prompt contains `Read demo_app/AGENTS.md first`, `Change only
demo_app/`, `Add a test`, and the exact requested popularity prompt. Changing
the prompt would not restore missing tool schemas. Raising autonomy or
allowing arbitrary Script/Execute would weaken the intended boundary and is
not the chosen fix.

The minimal supported configuration fix selects an explicit direct-file-tool
model via the official SDK `modelId`, defaulting to `claude-sonnet-4-6`. The
optional `PARADOX_DROID_MODEL` is forwarded only to the SDK subprocess, not
validation. The installed SDK 0.10.0 `createSession` and `updateSettings` do not
offer a public `toolExecutionMode` override; no unsupported field or private
wire workaround was added. The adapter now logs model/mode and file-tool
catalog metadata, and rejects script-only/unknown modes or missing read/write
tools **before `session.stream`**. It never enables Script or shell execution
and never silently switches models after a failure.

`AutonomyLevel.Off` is retained. The mandatory preflight requires Read, Edit,
and Create each with `allowed === true`, not just catalog presence. An
ApplyPatch-only catalog is insufficient. Even if `allowed: false` indicates
an approval-gated tool rather than an absent one, this adapter fails closed;
it never probes hypothetical weaker autonomy settings. A mocked SDK regression
performs a temporary-file write only after the existing handler approves it.

Offline local CLI catalog checks used `droid exec --list-tools --model ...`
under macOS `sandbox-exec` with **all network denied**. Sonnet's catalog includes
Read/Create/Edit; GPT's includes Read/ApplyPatch. This is catalog inspection,
not a model turn or authenticated end-to-end proof. The saved `script_only`
setting explains why catalog entries alone were insufficient in the failed
session; the new preflight checks both effective mode and allowed flags.
**Limitation:** the local read-only Sonnet catalog marks Create/Edit blocked.
If SDK session metadata agrees, the strict preflight will reject this default
configuration without a model turn. The catalog proves the model has direct
file-tool schemas, not that this account/session is permitted to use them.
No authenticated model discovery or new live turn was run during this fix.

### Exact installed SDK metadata implementation (0.10.0)

Paths below are relative to
`engine/droid_adapter/node_modules/@factory/droid-sdk/dist/`:

- `node.d.ts:844`: `listModels` lists models selectable by the spawned CLI;
  `includeDisabled: true` includes organization-disabled entries and reasons.
- `node.mjs:4627`: SDK `listModels` creates a configured client, invokes
  `client.listModels`, and closes the client in `finally`.
- `node.mjs:1316`: the underlying call sends `droid.list_models`.
- `node.mjs:4055`: `session.listTools` maps CLI `llmId`/`currentlyAllowed`
  to SDK `id`/`allowed`; `node.mjs:1385` sends `droid.list_tools`.
- `index-DWBA4zgW.d.ts:499`: execution modes are `direct_only` and
  `script_only` (tools exposed directly versus through Script).
- `node.mjs:3647`: session initialization forwards `modelId`; the public
  initialization/settings APIs do not offer an execution-mode override.

Neither metadata RPC adds a user message or calls `session.stream`: source
inspection shows no model turn. They can require authentication/network for
metadata; no inference credits are reported for preflight, and error results
leave usage null rather than inventing zero billed credits. `/api/agents`
continues using only the local import/CLI/version/key-presence probe. Actual
account permission is checked by `listModels` before session creation and by
the initialized session's effective model/mode/tools before streaming.

Regression coverage reproduces the exact script-only configuration, asserts
`stream` is never called for it or an empty catalog, checks explicit model
selection/override, absent/organization-disabled models, unknown modes,
disallowed Read/Edit/Create, model substitution, metadata failures, preflight
ordering, closure and null preflight usage. Mocked direct writes work with Off
while Script/WaitForScript/Execute remain disabled. A Python regression confirms
unchanged source still fails the real-change guard after SDK success.

Review-hardening offline commands (the earlier counts above are historical):

```sh
npm --prefix engine/droid_adapter test
env -u FACTORY_API_KEY .venv/bin/python -m pytest tests/test_droid_provider.py tests/test_generations.py -q
```

Results for this review hardening: **34 Node tests passed** (TypeScript build
included), **46 Python tests passed in 35.57 seconds**, and `git diff --check`
passed. All SDK session/model/tool interactions in these tests are mocked;
the Python real-runtime traversal checks use local fixtures, not paid Droid.

A second user-approved run is necessary to claim a successful real Factory
generation after the fix, not to diagnose this failure or review the offline
regressions. Model availability/account policy and actual CLI permission
behavior still need that end-to-end confirmation. **Wait for approval.**
