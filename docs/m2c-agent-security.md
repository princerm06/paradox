# M2-C agent security integration

Status: implementation and offline verification in progress. No real Factory call
is authorized or proved by these tests. Scripted M2 remains separately reviewable
in PR #26; this work does not change its tested revision.

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

No frontend, desktop artifact, real repository, paid provider, push or merge is part
of this helper implementation. Offline tests use disposable files and dummy keys.
