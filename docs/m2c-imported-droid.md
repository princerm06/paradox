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

## Offline integration evidence

- SDK policy slice `e35779b`: 78 Node tests and 38 Python provider tests passed.
  The session interface is mocked; no real Factory session is created.
- Shared helper/router source `c525fac`, plus the HTTP/provider tests in this
  report's commit: 9 real HTTP/direct-provider cases passed in 71.15 seconds.
  The trusted fixture imports the real compiled `runAdapter` and
  `verifyWriteSandbox` but supplies a fake SDK implementation. It performs real
  file edits, permission callbacks and kernel-denied write attempts. The normal
  compile, test, boot/smoke, adoption and activation pipeline runs without mocks.
- The success case records five passing tests, real changed files and patch,
  parent/future/generation association, the fake SDK session ID, permission
  decisions and invocation count in agent logs, and durable state after restart.
  Usage is null, not fabricated real-provider credits. Approval evidence is
  logged decisions; no new public approval-result schema is introduced.
- Failure cases cover SDK denial, SDK exception, no edits, invalid Python and a
  failing generated test. Each preserves the parent's active timeline and records
  the failing stage without adopting a future.
- Cancellation is durable. A separately seeded interrupted persisted record
  exercises startup recovery and removal of private residual SDK session files.
  This deterministic persistence test is not an OS-crash or real-SDK crash test.
- Every HTTP repository fixture contains a real SQLite source database with a
  sentinel row. Teardown checks all source and Git file hashes and mtimes, and
  queries the source sentinel read-only: the original repository is unchanged.
- Generated tests assert Factory/engine/shell credentials are absent. Provider
  tests verify only the trusted fake agent receives the dummy Factory key.
  Logs must not contain it. The actual kernel denies protected test/manifest
  writes and writes outside future code even without relying on the callback.
- An independent 40-test profile/validation regression passed in 28.56 seconds.

Commands run with Factory, Anthropic, OpenAI, engine and shell credentials unset
in the outer environment and `PARADOX_AGENT=scripted`; tests inject dummy-only
credentials and explicitly choose Droid for fake-SDK cases:

```sh
npm --prefix engine/droid_adapter test
.venv/bin/python -m pytest -q tests/test_project_droid_provider.py tests/test_droid_provider.py -k 'not live_droid'
.venv/bin/python -m pytest -q tests/test_project_droid_http.py
.venv/bin/python -m pytest -q tests/test_project_generation_profiles.py tests/test_project_generation_validation.py
```

Still required before M2-C offline GO: trusted-agent process-group cleanup review
and its adversarial regressions, final combined offline regression and security
handoff. No real-provider readiness is implied by mocked HTTP success.

Before separately authorized live verification: review ancestor configuration,
hooks/skills/MCP autoload and trusted-agent cleanup; verify actual effective
tool availability, real editing and recorded usage. The historical successful
demo run-3 evidence is unchanged and is not evidence of imported-project support.
