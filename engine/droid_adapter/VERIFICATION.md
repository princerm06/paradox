# Factory sponsor verification

## What is the official SDK integration?

Paradox pins **`@factory/droid-sdk` 0.10.0**, installed from the npm lockfile.
It is not an AI-shaped scripted demo and does not invoke `droid exec` directly.

The production call chain is:

1. `POST /api/generations` selects an explicit provider or `PARADOX_AGENT`
   (default `droid`). `Generations.run` checkpoints the parent and copies its
   code and SQLite state into a generation workspace.
2. `engine/providers.py` starts `node .../dist/adapter.js` through the mandatory
   macOS write sandbox (`engine/droid_sandbox.py`, `write_sandbox.sb`). Its stdin
   request contains the isolated code directory and wrapped feature prompt.
   Only the SDK subprocess receives `FACTORY_API_KEY`; validation does not.
3. `src/adapter.ts` dynamically imports **`@factory/droid-sdk/node`**, then calls
   **`createSession`** with `cwd`, **`AutonomyLevel.Off`**, **`disabledToolIds`**,
   **`permissionHandler`**, **`abortSignal`**, and disabled built-in skills.
   It explicitly selects `modelId` (default `claude-sonnet-4-6`, override
   `PARADOX_DROID_MODEL`), checks the session's `toolExecutionMode`, explicitly
   enables Read/Edit/Create using `session.updateSettings`, and calls
   **`session.listTools`** before streaming. SDK **`listModels`** first checks
   availability and organization restrictions; the initialized model must match
   the requested ID. Read, Edit and Create must each report `allowed === true`.
   Registered writes with `allowed: false` are not sufficient (see run 2).
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

**Do not repeat the paid command below without fresh user approval.** Both
authorized runs failed; the subsequent investigation and fixes are offline.

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

### Second paid run invalidated Option 1; strict gate restored

User-run evidence: `.venv/droid-proof-2/http-evidence.json`, generation
`f98456d7-0e05-48e0-ba95-8d1d786afc13`, SDK session
`58455bca-1df3-4822-a5ca-9abf9886fbf6`. SDK exit 0, generation failed at
`guard` with `Agent made no code changes`; timeline association null. Reported
cost **133,563 Factory credits** (421 input / 12,851 output tokens).

The run-2 preflight logged Read allowed/defaultAllowed true/true, Edit and
Create false/false. The model had Read, LS, Grep, Glob, TodoWrite and ToolSearch,
searched unsuccessfully for write tools, then returned code as prose. No
permission request was issued. Registration did NOT expose write tools:
`allowed: false` meant hidden from the model, not awaiting permission approval.
Off is effectively read-only in this configuration. The integration lead's
Option 1 recommendation and our accompanying approval-needed interpretation
were incorrect; the earlier strict gate was correct. Historical Option 1
sections below are retained as an audit trail, not current guidance.

Restored strict preflight: Read/Edit/Create must ALL have `allowed === true`
before streaming; missing/disallowed tools fail at existing stage `agent`,
with session closure and no model turn. Exact model/mode gates and both metadata
flags in logs remain. No autonomy change or security relaxation was implemented.
Strict-restoration offline tests: **41 Node passed** (including build),
**46 targeted Python passed in 36.44s** with `FACTORY_API_KEY` unset. The
run-2 catalog regression now rejects before streaming and closes the session.

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

`AutonomyLevel.Off` is retained. The user-approved Option 1 supersedes the
strict allowed-true write gate in `fc9d78b`: Read must have `allowed === true`,
but Edit and Create need only be registered. Either allowed value is accepted
for those writes because Off can require permission approval. An ApplyPatch-only
catalog is insufficient. No weaker autonomy settings are probed. The existing
permission handler still approves only scoped demo_app writes; a mocked SDK
regression performs a temporary-file write only after that handler approves it.

Offline local CLI catalog checks used `droid exec --list-tools --model ...`
under macOS `sandbox-exec` with **all network denied**. Sonnet's catalog includes
Read/Create/Edit; GPT's includes Read/ApplyPatch. This is catalog inspection,
not a model turn or authenticated end-to-end proof. The saved `script_only`
setting explains why catalog entries alone were insufficient in the failed
session; the new preflight checks both effective mode and allowed flags.
The local read-only Sonnet catalog marks Create/Edit blocked, which Option 1
now accepts as registered tools needing approval. The catalog proves the model
has direct file-tool schemas, not successful account/session write execution.
No authenticated model discovery or new live turn was run during this fix.

### Disabled tools remain registered in the catalog

**Disabled tools can be listed with `currentlyAllowed: false`, not omitted.**
With CLI 0.249.0, the network-denied command below removed Read, Edit, Create,
and Execute but returned all four entries. Read and Execute had
`defaultAllowed: true, currentlyAllowed: false`; Edit and Create had
`defaultAllowed: false, currentlyAllowed: false`. Thus a blocked flag cannot
distinguish an approval-gated write from a removed/disabled tool. The SDK's
`ExecToolInfoSchema` (`index-DWBA4zgW.d.ts:50256`) exposes only `defaultAllowed`
and `currentlyAllowed`, not a separate disabled/needs-approval indicator.
`node.mjs:4055` preserves `defaultAllowed` and maps `currentlyAllowed` to
`allowed`. The SDK forwards its `disabledToolIds` on initialization at
`node.mjs:3673`; the CLI removal probe illustrates the catalog ambiguity, not
a claim that we tested an authenticated SDK initialization.

```sh
env -u FACTORY_API_KEY /usr/bin/sandbox-exec \
  -p '(version 1) (allow default) (deny network*)' \
  "$HOME/.local/bin/droid" exec --list-tools --model claude-sonnet-4-6 \
  --output-format json --remove-tools Read,Edit,Create,Execute
```

Evidence is saved locally in `.venv/sonnet-removed-tools.json` (not committed).
This command exits after catalog discovery, has no feature prompt, denies all
network, and starts no paid generation. Protection against accidentally
disabling required writes therefore rests on the static not-in-
`DISABLED_TOOL_IDS` regression for Edit/Create, alongside the unchanged runtime
permission handler and restricted tools. Read still must be allowed. The
adapter logs `allowed` and `defaultAllowed` for each required tool (or missing).

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
disallowed Read, missing Read/Edit/Create, model substitution, metadata failures, preflight
ordering, closure and null preflight usage. Mocked direct writes work with Off
while Script/WaitForScript/Execute remain disabled. A Python regression confirms
unchanged source still fails the real-change guard after SDK success.

Review-hardening offline commands (the earlier counts above are historical):

```sh
npm --prefix engine/droid_adapter test
env -u FACTORY_API_KEY .venv/bin/python -m pytest tests/test_droid_provider.py tests/test_generations.py -q
```

Results for the earlier strict-gate review: **34 Node tests passed** (TypeScript build
included), **46 Python tests passed in 35.57 seconds**, and `git diff --check`
passed. All SDK session/model/tool interactions in these tests are mocked;
the Python real-runtime traversal checks use local fixtures, not paid Droid.

Option 1 final offline validation (Factory key unset for both Python commands):

- `npm --prefix engine/droid_adapter test`: **39 passed**, TypeScript build included.
- `env -u FACTORY_API_KEY .venv/bin/python -m pytest tests/test_droid_provider.py tests/test_generations.py -q`:
  **46 passed in 35.19 seconds**.
- `env -u FACTORY_API_KEY .venv/bin/python -m pytest -q`:
  **134 passed, 1 skipped in 204.59 seconds**; the live Droid test was skipped.
- `git diff --check`: passed.

The historical Option 1 regressions covered allowed and purported approval-needed writes, missing write
tools, missing/disallowed Read, static write-tool exclusion from the disabled
list, both catalog flags in logs, and the exact production `demo_app` write-root
path/escape matrix. The mocked SDK direct-file edit now exercises registered
writes with `allowed: false` and simulated permission-handler approval. Run 2
disproved that model of CLI behavior: those tools were hidden. The strict
restoration below rejects that catalog; this paragraph is historical evidence,
not the current policy or proof of real permission invocation.
No paid/live generation, push, merge, or Studio modification occurred.

The second user-approved run above failed; it did not establish successful
editing. Any third run requires a separate security/configuration decision
and user approval. Do not retry the current read-only configuration.

## Offline investigation after run 2

### Scope, versions and current production behavior

No model turn, paid generation, autonomy escalation in the production adapter,
or sandbox wiring was performed. Production remains Off with the restored
strict gate; it now rejects the observed read-only catalog at stage `agent`
without streaming. Script/Execute/WaitForScript and the other existing disabled
IDs are unchanged, as are the scoped handler, guard, provider selection and API.

Research environment: macOS `sw_vers -productVersion` **27.0**,
`/usr/bin/sandbox-exec` present and working, Node 24.22.1, CLI 0.249.0,
SDK 0.10.0. CLI binary SHA-256:
`fc61a51b3b65d913d828eebb10ebb441915d453cd6c6ae3cab78a16e459e4038`.
Binary offsets below apply only to this exact executable, not future releases.

### Metadata experiments and exact commands

`research/sdk_metadata.mjs` is an unwired metadata-only prototype. It never
streams or adds a user message. It creates an SDK `ProcessTransport` explicitly
and passes it to `createSession`, avoiding the normal API-key resolver solely
for this offline probe. The CLI may read cached local login/configuration, but
all network is denied and the key environment variable is unset. This is NOT
a replacement for production API-key authentication. Sessions/transport close
in `finally`; a 12-second abort bounds initialization.

From the repository root (after the existing adapter build):

```sh
mkdir -p .venv/offline-research/workspace/demo_app
for selection in enabled additional; do
  env -u FACTORY_API_KEY /usr/bin/sandbox-exec \
    -p '(version 1) (allow default) (deny network*)' \
    node engine/droid_adapter/research/sdk_metadata.mjs \
    off .venv/offline-research/workspace "$selection"
done
env -u FACTORY_API_KEY /usr/bin/sandbox-exec \
  -p '(version 1) (allow default) (deny network*)' \
  node engine/droid_adapter/research/sdk_metadata.mjs \
  low .venv/offline-research/workspace none
```

Each JSONL output contains full settings and all tool entries at:
initialization, actual catalog, a hypothetical `listTools` override query,
actual catalog again, `updateSettings`, and actual catalog after the update.
Local captures are `.venv/offline-research/sdk-off-enabled.jsonl`,
`sdk-off-additional.jsonl` and `sdk-low.jsonl`.
All probes reported zero permission requests and zero model turns: no tool
was invoked, so this is NOT empirical permission-handler execution evidence.

Results:

- All initialized sessions reported interaction mode **auto**; enabling writes
  did not change that mode or the Off autonomy level.
- Off actual: effective mode **direct_only**, Read allowed, Edit/Create blocked.
- Off + `updateSettings({enabledToolIds:['Read','Edit','Create'], disabledToolIds})`:
  effective mode stays **direct_only**, autonomy stays **off**, Edit/Create
  become allowed in the subsequent **actual** catalog. `additionalToolIds`
  instead of `enabledToolIds` produced the same observed result.
- Off + only hypothetical `listTools({enabledToolIds:..., disabledToolIds})`
  or `additionalToolIds`: reports writes allowed in THAT response, but a
  subsequent `listTools({})` still reports writes blocked. A hypothetical
  response must NEVER be used as the production preflight for actual settings.
- Low actual, with the **entire unchanged DISABLED_TOOL_IDS**: effective mode
  **direct_only**, Read/Edit/Create allowed, Execute blocked. Several unrelated
  tools become allowed too (see full table), making Low materially broader.

**SDK public-schema mismatch:** SDK 0.10.0 exports
`UpdateSessionSettingsRequestParamsSchema`, `ListToolsRequestParamsSchema`
and `ToolSelectionOverridesSchema` with only `disabledToolIds`, not enable/add
overrides. Parsing the probe objects with these schemas strips both
`enabledToolIds` and `additionalToolIds`. `ToolOverrideParamsSchema` is not a
public export here. Nevertheless `session.updateSettings` forwards the raw
JavaScript object (`node.mjs:4005`) and the installed CLI accepts these fields;
the settings notification and subsequent actual catalog confirm the change.
This runtime behavior is **not a supported, typed SDK contract**. No private
protocol patch or production cast was added. Factory confirmation or a typed
SDK update is preferable before relying on it in production.

For the separate bare-CLI catalog matrix, the exact flags used were:

```sh
DISABLED=$(node --input-type=module -e \
  "import{DISABLED_TOOL_IDS}from'./engine/droid_adapter/dist/adapter.js';console.log(DISABLED_TOOL_IDS.join(','))")
env -u FACTORY_API_KEY /usr/bin/sandbox-exec \
  -p '(version 1) (allow default) (deny network*)' \
  "$HOME/.local/bin/droid" exec --list-tools --model claude-sonnet-4-6 \
  --output-format json --remove-tools "$DISABLED"
```

This full-list bare-CLI command failed with **Unknown tool identifier(s)**:
the CLI validates selector names and some production disabled IDs are unknown
to this version. SDK initialization accepts the unchanged list. Combining
`--only-tools` and `--remove-tools` also failed explicitly as incompatible.
Those failed outputs/stderr are retained in `cli-off*` and `cli-low*` captures.
They are not treated as successful catalog measurements.

The successful bare-CLI variants used the same command prefix with these
selection flags instead of the full `--remove-tools "$DISABLED"`:

| Capture | Exact selection flags | Read current/default | Edit current/default | Create current/default | Execute current/default |
|---|---|---|---|---|---|
| cli-known-off.json | `--remove-tools Execute,Script,WaitForScript` | true/true | false/false | false/false | false/true |
| cli-known-off-add.json | `--remove-tools Execute,Script,WaitForScript --add-tools Read,Edit,Create` | true/true | true/false | true/false | false/true |
| cli-known-off-only.json | `--only-tools Read,Edit,Create` | true/true | true/false | true/false | false/true |
| cli-known-low.json | `--remove-tools Execute,Script,WaitForScript --auto low` | true/true | true/false | true/false | false/true |

Script/WaitForScript/ApplyPatch were absent from all these outputs. These CLI
variants are metadata-only controls, NOT proposed changes to the full production
disabled list. The complete SDK catalog below is the evidence for configurations
with that full list unchanged. Bare CLI `--list-tools` does not report effective
execution mode; that value above comes from real SDK session initialization,
not inference from the catalog. Passing add/only selectors at
SDK transport startup was also tested (`sdk_metadata.mjs off WORKSPACE none add`
and `... none only`); initialization reset them and actual writes stayed blocked.
Thus `createSession({execArgs:['--add-tools',...]})` is not a proven solution.

### Full SDK tool catalog output

All three SDK configurations returned these **33 entries**. `1` means true,
`0` false; defaultAllowed was identical across the configurations. Off-enabled
means an actual post-update catalog, not a hypothetical query. Off-additional
had the same table as Off-enabled. This records all registered catalog entries,
including blocked ones, rather than claiming all are exposed to the model.

| ID | defaultAllowed | Off allowed | Off-enabled allowed | Low allowed |
|---|---:|---:|---:|---:|
| AskUser | 0 | 0 | 0 | 0 |
| ConnectApp | 1 | 0 | 0 | 0 |
| Create | 0 | 0 | 1 | 1 |
| CreateAutomation | 0 | 0 | 0 | 1 |
| DeleteAutomation | 0 | 0 | 0 | 1 |
| DismissHandoffItems | 0 | 0 | 0 | 0 |
| Edit | 0 | 0 | 1 | 1 |
| EditAutomation | 0 | 0 | 0 | 1 |
| EndFeatureRun | 0 | 0 | 0 | 0 |
| Execute | 1 | 0 | 0 | 0 |
| ExitSpecMode | 0 | 0 | 0 | 0 |
| FetchUrl | 1 | 0 | 0 | 0 |
| GenerateDroid | 0 | 0 | 0 | 1 |
| GenerateImage | 0 | 0 | 0 | 0 |
| Glob | 1 | 1 | 1 | 1 |
| Grep | 1 | 1 | 1 | 1 |
| ListAutomations | 1 | 1 | 1 | 1 |
| ListAutomationTemplates | 1 | 1 | 1 | 1 |
| Loop | 0 | 0 | 0 | 1 |
| LS | 1 | 1 | 1 | 1 |
| ProposeMission | 0 | 0 | 0 | 0 |
| Read | 1 | 1 | 1 | 1 |
| ReadAutomation | 1 | 1 | 1 | 1 |
| RunAutomation | 0 | 0 | 0 | 1 |
| Skill | 1 | 1 | 1 | 1 |
| StageSettingsChanges | 1 | 0 | 0 | 0 |
| StartMissionRun | 0 | 0 | 0 | 0 |
| Task | 1 | 0 | 0 | 0 |
| TaskOutput | 0 | 0 | 0 | 1 |
| TaskStop | 0 | 0 | 0 | 1 |
| TodoWrite | 1 | 1 | 1 | 1 |
| ToolSearch | 1 | 1 | 1 | 1 |
| WebSearch | 1 | 0 | 0 | 0 |

**Script, WaitForScript and ApplyPatch were absent in all three catalogs**;
therefore their allowed/defaultAllowed values are unavailable, not fabricated
false. Script/WaitForScript remain explicitly disabled; ApplyPatch is not the
Sonnet file-tool profile. Read true/true, Edit/Create true/false after the
explicit update, and Execute false/true are the requested key observations.

### Permission-handler behavior: source evidence, not catalog inference

Source was inspected in the installed CLI executable with bounded string
extraction, without running a model or tool. The relevant symbol chain is:

- Byte **185167545**: `shouldAutoApproveFileEdits` delegates to `isAutoRunMode`;
  normal auto interaction with autonomy other than off returns true.
- Byte **187713014**: `Io` resolves the file auto-approval policy.
- Byte **187718179**: `Lo` handles direct Create/Edit confirmation. Each returns
  no confirmation if `Io(sessionPolicy)` is true; otherwise it builds create/edit
  details including the file path. ApplyPatch follows the same policy.
- Byte **187735638**: `CP` collects only tool uses requiring confirmation.
- Byte **194575802**: direct `requestConfirmationForToolUses` calls `CP`. If
  that batch is empty it returns approved IDs without calling
  `context.requestPermissionFn`. Otherwise, when the delegated permission
  function is installed, it calls that function with the confirmation batch.
- SDK `node.mjs:3618`, `setupClientHandlers`, wires our `permissionHandler`
  to `client.setPermissionHandler`; it cannot intercept a tool for which the
  CLI never sends a permission request.

Consequences under the inspected ordinary (non-mission, no bypass-hook) policy:

| Configuration | Expected direct Edit/Create confirmation behavior |
|---|---|
| Off, no explicit enable | Hidden; no edit reaches the handler (run 2 proves this). |
| Off + explicit enable/add update | File auto-approval remains false; source builds a confirmation batch and routes it to our handler. |
| Low | File auto-approval true; no edit/create confirmation batch; our handler is bypassed. |

Low therefore bypasses our `demo_app/` scope check for ordinary file edits.
Disabling Execute/Script does NOT fix that. Off plus explicit enablement is the
only observed configuration that both exposes writes and retains the source
path toward delegated confirmation. **Actual handler invocation under that
configuration has NOT been observed**: metadata probes invoke no tools. A
future approved tool execution must verify permission logs, not just catalog
flags. The CLI also has hook `allow-bypass` and legacy-mission exceptions;
trusted local configuration is assumed, not a guarantee against hostile hooks.
Local source excerpts are saved under `.venv/offline-research/`; raw executable
source is not vendored or patched.

### OS-level write sandbox prototype

`research/write_sandbox.sb` is **not wired to production**. It starts from
allow-default, denies all network and all filesystem writes, then permits
writes only beneath the isolated workspace, explicit Factory session/log
directories, a dedicated scratch TMPDIR, and `/dev/null`. Read access remains
unrestricted. It does NOT allow all of `~/.factory` or the engine repository.

```sh
ROOT="$PWD/.venv/offline-research"
mkdir -p "$ROOT/workspace/demo_app" "$ROOT/tmp"
printf 'outside sentinel\n' > "$ROOT/outside.txt"
env -u FACTORY_API_KEY TMPDIR="$ROOT/tmp" /usr/bin/sandbox-exec \
  -D "WORKSPACE=$ROOT/workspace" -D "SESSIONS=$HOME/.factory/sessions" \
  -D "LOGS=$HOME/.factory/logs" -D "SCRATCH=$ROOT/tmp" \
  -f engine/droid_adapter/research/write_sandbox.sb \
  node engine/droid_adapter/research/sandbox_smoke.mjs \
  "$ROOT/workspace" "$ROOT/outside.txt"
```

Observed output:

```json
{"insideWrite":"allowed","outsideWrite":"denied","symlinkEscape":"denied","childOutsideWrite":"denied","sentinel":"unchanged"}
```

The smoke process also verifies that the outside sentinel's bytes are unchanged.
Under the same profile, replacing the trailing Node smoke command with
`"$HOME/.local/bin/droid" exec --list-tools --model claude-sonnet-4-6 --auto low --remove-tools Execute,Script,WaitForScript --output-format json`
exited **0**, emitted its catalog, and had empty stderr. That startup smoke
uses the three named removals; the SDK probes use the full disabled list.
Replacing it with
`node engine/droid_adapter/research/sdk_metadata.mjs off "$ROOT/workspace" enabled`
also exited **0** with empty stderr: session initialized off/direct_only;
actual post-update Read/Edit/Create were allowed; Execute remained blocked.

Limitations: sandbox-exec is deprecated/macOS-only; this prototype working on
this machine does not guarantee future OS support. A live session may need
additional cache/telemetry/temp paths; none should be broadly granted without
evidence. Shared Factory sessions/logs are writable exceptions and could be
tampered with; use job-specific directories if Factory supports that safely.
Canonical paths, inherited descriptors, IPC/services, concurrent jobs,
cancellation and CLI descendants need adversarial testing. Allow-default plus
write denial is not a full hostile-code sandbox. Reads and credential exposure
remain outside its scope. The profile denies network entirely, so a real model
turn CANNOT work under this exact profile: controlled Factory network access
would need a separately approved design. No production network exception was
added. The post-run guard cannot undo writes outside the copied tree and is
not a substitute for OS enforcement.

### Recommendation for review (not implemented)

**Do not switch to Low.** It broadens the tool surface and bypasses the handler.
Keep the production strict gate and Off until explicit enablement is approved.
Prefer Factory-supported, typed enablement with the same proven runtime shape,
plus an independently reviewed write sandbox as defense in depth. Candidate
SDK configuration, only after approval and SDK compatibility review:

```ts
const session = await createSession({
  cwd: isolatedCodeDirectory,
  modelId: process.env.PARADOX_DROID_MODEL?.trim() || 'claude-sonnet-4-6',
  autonomyLevel: AutonomyLevel.Off,
  disabledToolIds: [...DISABLED_TOOL_IDS],
  autoRejectPermissionRequests: false,
  disableBuiltinSkills: true,
  abortSignal,
  permissionHandler: existingScopedPermissionHandler,
});
const overrides = {
  enabledToolIds: ['Read', 'Edit', 'Create'],
  disabledToolIds: [...DISABLED_TOOL_IDS],
};
await session.updateSettings(overrides);
```

The snippet is deliberately a research proposal, not production integration:
the extra enabledToolIds field passes structurally through a JavaScript object,
but SDK 0.10.0 does not declare it in the public settings type. Do not bypass
schema validation or ship an untyped override silently. If Factory cannot
support this configuration,
stay failed-closed; do not substitute Low as an automatic fallback. After an
approved update, preflight must query the ACTUAL session (only a toolIds filter,
no hypothetical autonomy/enable overrides), retain exact model/direct_only
checks, and require all three tools allowed. Close on every failure.

A future separately approved live run can prove actual model-visible writes,
permission-handler invocation/denial, CLI-child sandbox compatibility with
network, real source diffs, validation, adoption, cost and cancellation. Offline
metadata/source/smoke evidence proves none of those end-to-end claims. Do not
spend credits merely to discover the same read-only catalog again.

Final offline validation for the strict restoration and research handoff:
**41 Node tests passed**, **46 targeted Python passed in 36.44s**, and the
**full Python suite passed 134, with 1 live test skipped, in 205.94s**. Both
Python commands unset `FACTORY_API_KEY`. Both research scripts pass `node --check`;
the sandbox smoke assertions passed, SDK metadata probes exited 0, and
`git diff --check` passed. Failed bare-CLI selector controls are recorded above
and are not test-suite failures or hidden successful-probe claims.

## Approved production wiring: Off + explicit file tools + write sandbox

This section supersedes the earlier **not implemented** research recommendation.
The user approved implementation and offline testing only. No third paid run or
model turn was performed. The first two failures and their reported costs
(5,222 and 133,563 Factory credits) remain failures, not successful proofs.

### Exact SDK configuration and fail-closed checks

Production still pins `modelId` to `PARADOX_DROID_MODEL` or
`claude-sonnet-4-6`, uses `AutonomyLevel.Off`, unchanged `DISABLED_TOOL_IDS`,
`autoRejectPermissionRequests: false`, the existing demo_app-scoped
`permissionHandler`, disabled built-in skills and cancellation's abort signal.
It verifies initialized exact model, `direct_only` and Off, then performs:

```ts
const overrides = {
  enabledToolIds: ['Read', 'Edit', 'Create'],
  disabledToolIds: [...DISABLED_TOOL_IDS],
};
await session.updateSettings(overrides);
```

It rechecks model/mode/autonomy, queries the actual session with only
`listTools({toolIds: ['Read', 'Edit', 'Create']})`, logs allowed/defaultAllowed,
and requires all three allowed=true before `session.stream`. No hypothetical
catalog override can satisfy the gate. Update errors, ignored enablement,
unknown modes, changed models, unavailable/organization-disabled models and
missing/disallowed tools fail at `agent`; sessions close in finally. The guard
still rejects a successful SDK response with no real source changes. There is
no automatic provider/model/autonomy fallback, and Script/Execute/WaitForScript
remain disabled. The new audit line `permission handler audit: invoked=N`
records actual callback calls, including zero; mocks demonstrate recording but
are not evidence that a live enabled-write session invoked the callback.

The enablement wire field is intentionally the user-approved compatibility
path established in the previous source/protocol investigation: SDK 0.10.0's
public settings schema omits it, but `DroidSession.updateSettings` forwards the
object to the CLI, which accepts it. Production passes the structurally typed
variable without a schema parse or cast. The strict actual-session gate catches
an SDK/CLI version that stops accepting it. Retest this path on upgrades.

### Independent production enforcement

`engine/droid_sandbox.py` invokes `/usr/bin/sandbox-exec` around the Node adapter
and therefore its SDK/CLI descendants. The packaged profile denies file-write*
except for the canonical isolated `code/demo_app/`, private per-job
`workspace/.code-droid/home/.factory/`, private
`workspace/.code-droid/tmp/`, and `/dev/null`. Operational directories are 0700;
HOME/TMPDIR are replaced, so the user's shared Factory home is not writable.
The profile allows network for Factory authentication/inference and permits
reads. Application code outside demo_app, engine files, database state and
other futures are not write exceptions. The profile is narrower than the
historical research prototype; it does not allow the whole workspace or shared
Factory sessions/logs. The SDK still uses the real key only in its environment;
probe environments omit it, and tests do not print or commit credentials.

`/api/agents` checks the OS/binary/profile and a zero-network kernel write-deny
probe in addition to the existing offline Node/SDK/CLI/key checks; no model or
catalog RPC occurs in this endpoint. Every job performs an independent
allow-scratch/deny-code-root check before SDK launch. The adapter itself then
requires the engine marker AND verifies demo_app writing succeeds and a
code-root write fails before importing the SDK. A forged marker or permissive
profile is insufficient. Sandbox startup failure is terminal, not an opt-out.
Non-macOS platforms fail closed rather than running an unprotected Droid.

### Offline evidence on macOS

Automated production-profile tests (key unset) verify:

- demo_app writes succeed; code-root README, engine.py, outside sentinels and
  generation state SQLite writes fail with EPERM/EACCES and preserve bytes.
- A symlink within demo_app pointing outside does not permit an outside write;
  linking an outside file into demo_app is denied. A spawned Node child inherits
  the restriction. Private Factory and scratch writes succeed.
- A forged marker on an unsandboxed Node process and an allow-all sandbox
  profile are rejected. Missing platform/binary/profile, startup exit, timeout
  and OSError fail closed. API failure remains stage agent, no timeline or
  scripted substitution. Existing timeout/cancel/no-edit regressions remain.
- The production permission policy is tested with
  `writeRoot=path.join(root, 'demo_app')`: relative/absolute demo paths pass;
  workspace-root README, engine/x.py, traversal, absolute outside paths,
  escaping symlinks, demo_app/node_modules, directory-only targets, an
  apply_patch move outside demo_app, exec and script all fail.
- Required network capability is tested only by a local TCP round-trip, not by
  an external request or model turn.
- The real installed CLI starts with the private empty HOME under the profile
  with an additional `(deny network*)`, using metadata-only `--list-tools`.
- The real official SDK creates a metadata-only session under that same
  network-denied production profile/private HOME, then enables the three file
  tools. Actual settings retain model claude-sonnet-4-6, Off, direct_only;
  Read/Edit/Create each report allowed=true, Execute reports allowed=false.
  Script/WaitForScript are absent from this direct-only catalog (absence and
  disallowed entries are both non-exposure; they remain in disabledToolIds).
  It records permissionRequests=0 and modelTurns=0 and never calls stream.
  `research/sdk_metadata.mjs` uses the SDK's explicit ProcessTransport only for
  this key-unset offline metadata research, not production authentication.

Reproduce these zero-cost checks from this worktree:

```sh
env -u FACTORY_API_KEY npm --prefix engine/droid_adapter test
env -u FACTORY_API_KEY .venv/bin/python -m pytest tests/test_droid_sandbox.py tests/test_droid_provider.py -q
env -u FACTORY_API_KEY .venv/bin/python -m pytest tests/test_droid_sandbox.py tests/test_droid_provider.py tests/test_generations.py -q
env -u FACTORY_API_KEY .venv/bin/python -m pytest -q
```

The tests construct the exact sandbox-exec command using production `prepare`;
for the real SDK metadata check the final argv is
`node engine/droid_adapter/research/sdk_metadata.mjs off <isolated-code> enabled`,
wrapped by the production profile plus `(deny network*)`. No real model stream
or paid verifier command is invoked. CLI/catalog tests require the installed CLI and
built SDK; kernel tests skip on non-macOS, where production Droid is unavailable.

### Remaining limitations and approval boundary

sandbox-exec is deprecated and macOS-specific; availability is not a guarantee
of support on other OS releases. Allow-default IPC/network/reads and writable
operational directories are not a full malicious-code sandbox. Factory-key
exfiltration, arbitrary reads, non-filesystem side effects, compromised CLI
behavior and sandbox escapes are outside the assurance here. Inherited stdout
log descriptors are deliberate writable exceptions; private Factory logs may
contain sensitive session content and should not be published wholesale. The
engine should still be run only on trusted local projects. The permission
handler additionally blocks node_modules/.git inside demo_app, but the kernel
profile itself permits demo_app writes and does not independently implement
all per-file handler policy. No untrusted subprocess capability is enabled.

Private-HOME real authentication, networked model execution, actual permission
callback invocation for model writes, generated edits/validation/adoption,
CLI updates and live cancellation remain unproven for this configuration.
Offline source and catalog evidence must not be described as end-to-end SDK
success. A third paid verification needs the user's separate explicit approval;
it was not run as part of this work.

Offline checks after production wiring: Node **48 passed** (TypeScript build
included); sandbox/provider Python **45 passed in 14.35s**; expanded
sandbox/provider/generation Python **66 passed in 51.15s**. Commands unset
FACTORY_API_KEY. An initial full-suite run exposed one older protocol mock
that did not mock the newly mandatory sandbox boundary; that mock is now
explicitly isolated, while the independent real-kernel tests remain enabled.
The corrected full offline Python suite passed **154 tests, 1 live test skipped,
in 224.02s** with FACTORY_API_KEY unset. `git diff --check` passed. No paid run,
real model turn, frontend/scripted-provider change, push or merge was performed.
