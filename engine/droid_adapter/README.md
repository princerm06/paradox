# Droid adapter

A small Node subprocess that runs one Factory Droid turn through the official
TypeScript SDK, [`@factory/droid-sdk`](https://www.npmjs.com/package/@factory/droid-sdk)
(pinned to `0.10.0`, Apache-2.0). The Python engine launches it and talks to it
over stdin/stdout.

## Build

```bash
cd engine/droid_adapter
npm ci
npm run build   # tsc -> dist/adapter.js
npm test        # build + node:test against a mocked SDK (no network, no key)
```

`node_modules/` and `dist/` are not committed. The engine treats the adapter as
available only once `dist/adapter.js` exists.

## Runtime requirements

- **Node.js >= 20.** The SDK itself declares `>=18`.
- **macOS with working `/usr/bin/sandbox-exec`.** Kernel enforcement is
  checked offline and for every job. Unsupported or failed sandboxes stop
  Droid; there is no unsandboxed or Autonomy Low fallback.
- **The `droid` CLI on `PATH`.** The SDK's Node entrypoint
  (`@factory/droid-sdk/node`) does not call the Factory API directly. It spawns
  the `droid` CLI as a child process and talks to it over JSON-RPC on stdio. If
  `droid` is not installed, `--probe` fails and runs fail at session creation.
  Install the CLI separately with Factory's installer. It is not an npm
  dependency here.
- **`FACTORY_API_KEY` in the environment.** This is the only supported way to
  authenticate. The adapter never accepts a key on stdin or argv and never
  prints it. The SDK reads the variable and passes it to the `droid` child.
  The adapter checks only whether the variable is present, and uses its value
  only to redact it from diagnostics.

## Protocol

Start the Python engine; it launches the adapter inside the mandatory write
sandbox, with the isolated code directory as cwd. Bare adapter launches are
rejected before SDK initialization (except the offline `--probe`):

```bash
.venv/bin/python -m engine
```

**stdin** is a single JSON object, followed by EOF:

```json
{"cwd": "/abs/scratch/code", "prompt": "Fix the failing test in demo_app"}
```

`cwd` must be an absolute path to an existing directory. It is canonicalized
with `realpath` and becomes the Droid session cwd. Only its `demo_app/` subtree
is permitted for edits; this is a permission policy, not an OS sandbox.

**stdout** is JSON Lines. It contains zero or more `log` lines, then exactly
one `result` line, which is always last:

```json
{"type":"log","message":"tool_call: Edit"}
{"type":"result","exit_code":0,"session_id":"…","summary":"…","usage":{"input_tokens":120,"output_tokens":30,"factory_credits":0.5}}
```

- `session_id`, `summary`, and every `usage` field may be `null`.
- `usage` is the SDK's per-turn `DroidResult.tokenUsage`. `factory_credits` is
  `null` when Factory does not report it.
- Log messages are sanitized and capped at 2000 characters. `summary` is the
  final assistant text, sanitized and capped at 8000 characters.

**stderr** carries diagnostics only, prefixed `[droid-adapter]`. API keys and
key-like tokens are redacted.

**Exit codes**

The process exit code matches the `result.exit_code` field.

| code | meaning |
| ---- | ------- |
| 0    | Turn succeeded |
| 1    | Turn failed, or an SDK/CLI error occurred |
| 2    | Bad stdin, or `FACTORY_API_KEY` is missing |
| 3    | The SDK could not be loaded (`--probe`: SDK or `droid` CLI missing) |
| 130  | Interrupted (SIGTERM/SIGINT aborts the session) |

### Probe

```bash
node dist/adapter.js --probe
# {"ok":true,"sdk":true,"droid_cli":true,"detail":null}
```

The probe exits 0 only if `@factory/droid-sdk/node` imports and exports
`createSession` and `AutonomyLevel`, and a `droid` executable is on `PATH`. It
does not need a key and makes no network calls. The Python side checks
`FACTORY_API_KEY` separately.

## SDK API used

The adapter imports these from `@factory/droid-sdk/node`:

- `createSession(options)`, called with:
  - `cwd`: the canonical workspace.
  - `autonomyLevel: AutonomyLevel.Off`. Read/Edit/Create are explicitly enabled
    through `session.updateSettings({enabledToolIds: [...]})`. Do not assume
    every edit invokes the permission handler; the kernel write sandbox is
    mandatory and handler invocation counts are audited.
  - `disabledToolIds`: every non-file tool known to SDK 0.10.0. This covers
    `Execute`, `Script`, `WaitForScript`, `WebSearch`, `FetchUrl`, `Task`,
    `SpawnAgent`, `AskUser`, the mission/workstream tools, connectors,
    `GenerateImage`, and so on. See `DISABLED_TOOL_IDS` in `src/adapter.ts`.
  - `permissionHandler`: see below.
  - `autoRejectPermissionRequests: false`, so requests reach the handler.
  - `disableBuiltinSkills: true`.
  - `abortSignal`, used for interruption.
  - No `askUserHandler`. The SDK declines AskUser requests when none is set.
- `session.stream(prompt, { abortSignal })`. The adapter maps `assistant`,
  `tool_call`, `tool_result`, `error`, and `hook` messages to `log` lines. The
  final `result` message supplies `sessionId`, `text`, `success`/`interrupted`,
  `error`, and `tokenUsage`.
- `session.close()`, always called in `finally`.

### Permission policy

The handler returns `proceed_once` only when all of the following hold:

- `proceed_once` is one of the offered options.
- Every tool use in the batch has confirmation type `edit`, `create`, or
  `apply_patch`.
- Every target path stays inside `cwd/demo_app`. Relative paths resolve from
  `cwd`, not from `cwd/demo_app`. For `apply_patch`, this includes every
  `files[].filePath` and `files[].moveTo`. Paths are resolved through symlinks
  of their nearest existing ancestor, and `..` escapes and symlink escapes are
  rejected.
- No target path contains a `.git` or `node_modules` segment.

Anything else is answered with `cancel`. That includes `exec`, `script`,
`mcp_tool`, `sandbox_violation`, `droid_shield_violation`, `ask_user`, mission
requests, and unknown types. Each decision is logged.

## Model and tool surface

The adapter explicitly selects `claude-sonnet-4-6` by default; set
`PARADOX_DROID_MODEL` to select another model with a **direct file-tool** surface.
It does not inherit an arbitrary CLI model default. Before `session.stream`, it
uses SDK `listModels({cwd, includeDisabled: true})` to reject unavailable or
organization-disabled models, verifies the initialized model ID matches the
requested ID, checks `session.settings.toolExecutionMode === 'direct_only'`,
and verifies autonomy stays Off. It then calls `session.updateSettings` with
`enabledToolIds: ['Read', 'Edit', 'Create']` and the unchanged disabled IDs.
This CLI wire field works with SDK 0.10.0/CLI 0.249.0; SDK 0.10.0's settings
schema omits it, although the SDK forwards the raw object. After configuration
the adapter rechecks model/mode/autonomy and requires the actual-session
`session.listTools({toolIds: ['Read', 'Edit', 'Create']})` to report each with
`allowed === true`**. The second paid run showed that registered writes with
`allowed: false` are hidden from the model, not awaiting handler approval. Missing or
unknown mode metadata fails closed. Script-only sessions
fail with a clear configuration error before streaming: allowing Script would
bypass the adapter's file-only permission policy. `AutonomyLevel.Off` remains
enabled; direct edit/create permission requests still receive `proceed_once`
only for valid paths. ApplyPatch is not a substitute for missing Edit/Create.
Disabled tools can remain in the catalog with `allowed: false`, so a static
regression ensures Edit/Create are never in `DISABLED_TOOL_IDS`. The scoped
handler and independent kernel restriction enforce demo-only application
writes. Logs record both `allowed`
and `defaultAllowed` for all three tools. No autonomy increase or hypothetical
weaker-settings probe is used. See `VERIFICATION.md` for offline evidence.
Model/tool discovery uses metadata RPCs, not model turns; `/api/agents` does
not make those authenticated calls and remains an offline prerequisite probe.

## Mandatory write sandbox

`engine/droid_sandbox.py` wraps Node and its SDK/CLI descendants in
`write_sandbox.sb`. Network is allowed, reads are unrestricted, and filesystem
writes are denied except to canonical `code/demo_app/`, a private per-job
Factory home, private scratch, and `/dev/null`. HOME and TMPDIR point to these
0700 operational directories, not the user's existing Factory home. The code
root, engine, sibling source, and generation SQLite state are not writable.
Python verifies allow/deny behavior before launch; Node verifies an actual
demo write and denied code-root write before importing the SDK. A marker alone
does not establish enforcement. Failed probes stop at the existing `agent`
stage without provider fallback.

The final audit log records `permission handler audit: invoked=N` in addition
to each permission decision. Zero invocations do not prove handler enforcement.
Kernel tests independently reject outside writes, symlink/hard-link escapes,
and child-process writes outside the application boundary.

## Known limitations

- **Mocked tests are not live-generation proof.** For exact official SDK
  integration points, current evidence, and the one-call HTTP reproduction
  tool, see `VERIFICATION.md`. The original implementation was built without
  a CLI/key; availability now probes installed prerequisites but does not make
  a paid authentication check. A successful session alone does not prove that
  every CLI operation is constrained by the permission handler.
- **The tool block is subtractive only.** The public SDK has no allowlist (the
  docs say so explicitly). A tool introduced by a newer `droid` CLI that is not
  in `DISABLED_TOOL_IDS` is not disabled. If it asks for permission, the handler
  still cancels it. Otherwise the kernel write boundary remains, but reads,
  network and other side effects are not comprehensively restricted.
- **Reads cannot be scoped.** Read-only tools (`Read`, `LS`, `Glob`, `Grep`)
  may run without a permission request, so the handler cannot keep them inside
  `cwd`. The SDK offers no read-path restriction. Edits are scoped, and reads
  outside `cwd` are not prevented by the adapter or write sandbox.
- **Not hostile-code isolation.** sandbox-exec is deprecated/macOS-only.
  Allow-default IPC/network/reads, operational directories and inherited log
  descriptors remain exceptions. This is defense in depth, not a container or
  protection against a compromised CLI. No real turn has verified private-HOME
  compatibility or actual permission-handler invocation with enabled writes.
- **Python owns the timeout.** The engine enforces a 300-second deadline, sends
  SIGTERM, waits up to one second, then kills the process group. The adapter
  aborts the session on SIGTERM/SIGINT and reports exit code 130 when it can.
- **`npm audit` reports transitive advisories.** At SDK 0.10.0 these are in
  `uuid` (<11.1.1) and `zod` (<4.6.6), both pinned by the SDK's ranges. The
  only automated "fix" downgrades the SDK.
