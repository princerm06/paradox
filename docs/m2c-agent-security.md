# M2-C agent security integration

Status: **GO for offline mocked-SDK integration on disposable fixtures;
NO-GO for real-provider/user-repository verification.** No real Factory call is
authorized or proved by these tests. Scripted M2 remains separately reviewable in
PR #26; this work does not change its tested revision.

## Boundaries

The Factory agent is a trusted, credential-bearing development tool. Imported
application code remains untrusted. They do **not** share a sandbox, HOME, scratch
directory, writable state, or environment. The imported execution sandbox's
single-process, home/process-information/Mach/network restrictions are unchanged.

Imported Droid requires both explicit `provider: "droid"` and the operator setting
`PARADOX_IMPORTED_DROID_ENABLED=1`; the default stays scripted. This setting enables
the integration, not consent to a particular external transmission or paid call.
Repository runtime trust does not constitute such consent. Real verification still
requires explicit user approval.

## Internal helper contract

`engine.imported_agent_sandbox` provides:

- `protected_files(code, profile) -> tuple[str, ...]`: sorted relative POSIX paths;
  existing baseline tests, immutable manifest patterns, validation control files,
  and files outside editable prefixes. Slashless immutable patterns match the
  basename at any depth; slash-containing patterns match the full relative path.
- `availability_reason() -> str | None`: credential-free macOS enforcement probe;
  unavailable platforms fail closed.
- `prepare(code, command, environment, profile) -> (argv, environment)`: whole trusted
  agent command wrapped by macOS write confinement. Absolute trusted executable
  required. Marker: `PARADOX_DROID_SANDBOX=macos-project-write-v1`.
- `cleanup(code) -> None`: remove only that future's private operational directory,
  after the agent process has been reaped. Refuse symlink/unowned/non-private roots.

Inventory rejects symlinks, hardlinks, special files, more than 4096 entries,
individual files over 256 KiB, and total content over 16 MiB. Existing `.factory`,
`.claude`, `.agents`, `.codex`, `.mcp.json`, `.git`, and `node_modules` are rejected
at every depth, case-insensitively. New control/autoload paths and `.pth` hooks are
write-denied. Existing protected files and their ancestor directories cannot be
overwritten, removed, atomically replaced, or renamed by the agent. New tests can
be added. Post-generation immutable/bytecode/diff guards remain mandatory.

Fixed autoload names are also checked by metadata only at **every canonical cwd
ancestor**, capped at 64. Any existing entry or dangling symlink fails closed;
contents are never opened. Consequently a state path under a home containing
`~/.codex` or `~/.claude` may be unavailable: imported Droid currently requires a
dedicated state path with clean ancestors. This conservative compatibility gate is
not proof of every SDK/CLI autoload behavior, and is not relaxed by operator opt-in.

Only the future code, a private Factory directory and scratch directory are
writable. Agent operational state lives under a per-user 0700 system-temp directory,
keyed by the canonical future-code path hash, **outside** the entire generation and
runtime read allowlists. Existing operational directories are not silently reused.
Only `FACTORY_API_KEY` and the selected model are accepted from the caller's agent
environment; engine bearer/shell tokens, other provider keys and Node injection
variables are not inherited. Enforcement probes never receive provider credentials.

The Node adapter receives only engine-derived
`project: {adapter, editable_prefixes, immutable_paths, protected_files}`. The SDK
permission policy must independently enforce these paths, refuse non-file tools,
reject unexpected enabled tools, and verify the imported sandbox marker and
enforcement before SDK initialization. The demo uses its unchanged existing policy.

## Security findings and remaining gates

- A demo-style sibling agent HOME would have been inside the validation read root.
  Imported agent state is moved outside it, with a real application-sandbox read
  denial regression and explicit completion/restart cleanup.
- macOS SBPL accepted `(?i)` without providing the intended case-insensitive match
  in a disposable probe. The implemented rules use explicit upper/lower character
  classes, with uppercase control-file regressions.
- Source/state hardlink and symlink write attempts and protected-file replacement
  require actual kernel denial, not just a model prompt or SDK approval callback.
- This is a **trusted agent write sandbox**, not the application's read/network/exec
  security boundary. The agent needs provider networking and subprocesses; it must
  never execute imported code. Its broad read access is not a guarantee against
  model-driven external disclosure. Review SDK/CLI ancestor configuration, skills,
  hooks, MCP autoload and enabled tools before any real-provider run.
- Completion/cancel/timeout/restart operational cleanup and mocked HTTP generation,
  validation, preview and activation credential tests are required integration gates.
  Trusted SDK detached-descendant behavior still needs explicit review; the runtime
  single-process guarantee must not be misrepresented as an agent-tree guarantee.
- The trusted supervisor previously skipped session cleanup when the root already
  exited, or stopped after the root handled TERM, leaving same-session children.
  It now always TERM/KILLs the known child session group. Disposable TERM-resistant
  mock-agent descendants are stopped on completion, cancellation, timeout, and
  engine-liveness EOF. This does not prove cleanup of deliberately detached SDK
  descendants; no runtime fork restriction is weakened to accommodate the agent.

No frontend, desktop artifact, real repository, paid provider, push or merge is part
of this helper implementation. Offline tests use disposable files and dummy keys.

## Final offline gate

Exact combined production/test source:
`0ede14e73f1ef3168ce3920552dca01bc857523d`. Both lanes are included by Git ancestry,
not copied files. This report is an additive documentation-only change.

- Full backend regression: **561 passed, 1 skipped, 1 deselected in 754.33 seconds**;
  JUnit records 562 cases, zero errors, zero failures, one skip. Durable runner rc 0.
- The skip is `tests/e2e/test_long_generation.py:13`, the opt-in four-minute scripted
  rehearsal. The sole deselection is
  `test_live_droid_generation_records_a_complete_result`, deliberately excluded.
- Node adapter: **78 passed**, with SDK dependency installation from the offline
  npm cache. Tests inject a mocked session, not a real provider turn.
- Security/helper/ancestor/recovery/launcher slice: **54 passed in 6.83 seconds**
  on `85ca77f` (same production/test tree as the final combined source).
- Independent B HTTP/mock-provider, runtime credential and runtime-security slice:
  **25 passed in 102.81 seconds** on that same tree. Earlier focused counts overlap;
  they are not added together to inflate the final full-suite count.

The full runner uses an allowlisted environment, with no provider/engine/shell keys,
`PARADOX_AGENT=scripted`, and explicit live-test exclusion. Individual tests set
dummy credentials and explicitly select mocked Droid. It verifies real sandboxed
compile/tests/runtime, immutable source/Git/source-SQLite fingerprints, permission
denials, cancellation, private state cleanup and durable recovery.

Durable local evidence: `/tmp/paradox-m2c-offline-full.log`,
`/tmp/paradox-m2c-offline-full.xml`, `/tmp/paradox-m2c-offline-status.json`.

Before a separately authorized real-provider run, resolve the trusted agent's
broad host/private-auth-artifact read disclosure risk and validate CLI lifecycle /
autoload behavior in an explicitly isolated environment. Pinned SDK 0.10.0's
`invokeNodeSpawn` uses cwd/env/stdio without `detached: true`; this source review
does not prove that the separate CLI binary cannot create detached descendants.
Retain user-approved disposable-project scope, review the exact effective tools
and model, obtain explicit external-transmission/cost approval, and collect actual
diffs, permissions, validation, usage and cleanup evidence. No mock success should
be described as genuine AI-provider verification or final product completion.
