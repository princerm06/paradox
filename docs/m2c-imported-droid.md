# M2-C: imported-project Droid integration (offline development)

## Scope and opt-in

The existing official Factory SDK adapter is extended to accept an internal
project policy for `fastapi-sqlite-v1` isolated future workspaces. This is an
open-ended development prompt, not a scripted recipe lookup. Imported projects
still default to scripted generation. Droid requires an explicit `provider:
"droid"` selection and the operator setting `PARADOX_IMPORTED_DROID_ENABLED=1`.
That setting is not permission to initiate a paid verification run. No real
model turn is authorized by this implementation or its tests.

Repository trust currently covers local test/server execution. It is not
informed consent to transmit repository content externally or incur charges.
Before a live run, the operator must separately approve the disposable project,
request, provider, and cost exposure. This is not arbitrary-framework support.

## Internal boundary

`Providers.availability(provider, profile=DEMO_PROFILE)` is backwards compatible.
The imported path in `Providers.run` uses Codex 2's
`engine.imported_agent_sandbox.protected_files(code, profile)` and
`prepare(code, command, environment, profile)`, followed by `cleanup(code)` in a
`finally` block after the agent subprocess is reaped, including preparation
failure. Private operational HOME/Factory/tmp lives outside the generation tree
so it cannot become readable to imported tests or runtime. No helper implementation is
copied into the provider. Unsupported or failed confinement stops generation;
there is no unsandboxed, autonomy-escalation, or scripted fallback.

The SDK receives a trusted internal `project` object with exactly `adapter`,
`editable_prefixes`, `immutable_paths`, and `protected_files`. It is derived from
the saved profile and bounded protected-file inventory, never request JSON.
It permits new application files and tests, but existing tests, manifests and
control/autoload files are protected. Only future code is editable: original
repositories, runtime state, snapshots and other futures are not agent targets.

The demo input and sandbox remain unchanged. SDK 0.10.0 remains pinned. Both
modes require the exact selected available model, Autonomy Off, `direct_only`,
explicit Read/Edit/Create enablement, and `allowed=true` for all three tools
before streaming. Imported mode additionally disables ToolSearch, supplies no
MCP servers, and rejects any allowed tool outside Read/Edit/Create/LS/Grep/Glob/
TodoWrite. Permission decisions and invocation counts are logged, and sessions
close on success, failure and interruption. Zero handler calls is observable,
not proof of scope enforcement: kernel confinement remains required.

Only the trusted agent receives the Factory credential. Engine bearer/shell
credentials are scrubbed; application, validation and preview retain their
separate scrubbed environments and existing single-process execution sandbox.
Provider results preserve session identifiers, usage and logs. Existing
generation orchestration retains diffs, validation, no-change/immutable guards,
failure records, cancellation and restart recovery.

## Evidence and remaining gates

The initial slice has mocked SDK Node policy tests and Python provider-boundary
tests. They exercise actual mocked SDK edits, permission denial, failure,
interruption, session closure, strict tool catalogs, exact payloads, operator
opt-in and credential separation. They do not prove live Droid behavior.

Still required before M2-C offline GO: reviewed imported-agent kernel helper,
router/profile integration by shared ancestry, real HTTP mocked-SDK generation
through sandboxed validation/runtime, cancellation/recovery and unchanged-source
evidence, followed by the combined offline regression suite.

Before separately authorized live verification: review ancestor configuration,
hooks/skills/MCP autoload and trusted-agent cleanup; verify actual effective
tool availability, real editing and recorded usage. The historical successful
demo run-3 evidence is unchanged and is not evidence of imported-project support.
