# M2-B step 2: static adapter and execution sandbox

This delivery implements the frozen Project Adapter v1 hooks from
`docs/contracts/m2-projects.md` at `69a8123`, on top of approved demo-neutral
profile refactor `f4fa14e`. It does **not** enable imported-project runtimes,
add project/trust routes, or execute a registered repository. Runtime's existing
non-demo refusal remains in place. The next delivery requires architect review.

## Boundaries

- `exec_sandbox.wrap(argv, writable, run_root)` fails closed without macOS
  `sandbox-exec` and an enforcement probe. The probe checks state writes,
  outside reads/writes, shell exec denial, outbound denial, loopback sockets,
  numeric `KERN_PROCARGS2` denial and fork/posix_spawn denial. Its result is cached
  per engine process. Imported execution is now single-process by explicit user
  approval; `(deny process-fork)` enforces it, not an application convention.
- Commands must use the engine interpreter. The trusted engine computes its
  symlink chain once (at most eight paths), verifies every alias resolves to the
  same interpreter, and grants only exact read/exec literals plus the Framework
  Python.app re-exec literal. The argv preserves the engine venv shim; exact
  pyvenv.cfg read access retains the engine environment even with `-I`. No venv/bin
  subpath grant is used, and pyvenv.cfg is read-only. Shells, pip and copied
  interpreter binaries cannot execute. The exec allowlist is by resolved file
  identity; aliases to the approved interpreter are equivalent and remain
  sandboxed. Tests prove run-tmp symlink exec-in-place still cannot write outside state,
  read the engine environment, signal the engine, or connect externally.
- File contents are readable only under the private run root, engine interpreter,
  engine site-packages, and fixed OS runtime locations. Ancestor directory
  metadata and the filesystem-root literal are necessary for Framework Python's
  startup; this is not recursive access to ancestor contents. Home contents and
  sibling engine state remain denied except these explicit trusted locations.
- Writes are restricted to caller-granted existing directories or exact regular
  files under the run root. Symlink grants, external grants, the run root itself,
  and hard-linked file grants are rejected. `/dev/null` has an additional exact
  write exception: pytest's built-in logging opens it even with no log configured.
  Code is not writable unless a trusted caller incorrectly grants it. Callers
  must grant only state/test-state, private tmp, and a precreated exact report.
- All network operations are denied except the frozen loopback bind, inbound,
  and remote-loopback outbound rules. The unsafe `allow network* (local ip ...)`
  shortcut is not used. Localhost is not a trust boundary: engine auth is still
  required and this does not protect another unauthenticated localhost service.
- Mach service lookup and user-preference reads are denied, with no Mach service
  exceptions. This prevents brokering access through pasteboard, SecurityServer,
  securityd, LaunchServices, cfprefsd, WindowServer or mDNSResponder/DNS services.
  Network denial alone did not close these brokered channels. The availability
  probe checks pasteboard lookup denial; regressions check all these services,
  including `com.apple.dnssd.service`. Name resolution is unavailable, even for
  `localhost`: imported applications, tests and health probes must use numeric
  `127.0.0.1`. Adding a Mach allowance requires separate architect approval.
- `process-info*` is denied except self. That alone did **not** block reading the
  parent's environment through ctypes and numeric `sysctl(KERN_PROCARGS2)` in
  testing. Default-deny `sysctl-read` closes that tested vector. The only read
  exceptions are kern.ostype, kern.hostname, kern.osrelease, kern.version,
  hw.machine and hw.ncpu. These public system values keep os.uname, platform
  queries and os.cpu_count working; kern.hostname is exposed to imported apps,
  an accepted minor disclosure. Tests cover numeric KERN_PROCARGS2 and KERN_PROC
  for the launcher and engine PIDs, plus failing kern.procargs/kern.procargs2
  sysctlbyname probes (bare and PID-qualified names), ps exec and absent/denied
  /proc environment paths. No other sysctl reads are allowed.
- Signals are denied except targets in the same sandbox. Imported processes
  cannot signal the control-plane engine, launcher or user processes; their own
  process can signal itself, but cannot create workers. The unsandboxed control-plane can still
  terminate sandboxed process groups on cancellation and timeout. Tests use
  harmless signal 0 for permission probes, never destructive signals to shared
  processes. Interpreter replacement retains the sandbox. The trusted external
  runtime supervisor owns termination; it is not an app-removable inner watchdog
  or just an inner uvicorn command wrapper.
- `environment(base, run_tmp)` starts from `scrubbed_environment()`. Only the
  application state variable is accepted from base; HOME, TMPDIR, Python cache,
  and Python import paths are overwritten. Fixed engine site-packages plus cwd
  support normal Python startup without importing arbitrary engine sources.
  Provider credentials, engine bearer/shell tokens, Python injection variables,
  and dynamic-loader injection variables are not copied. Every process fixture
  checks the four dummy credential sentinels, never real credentials.

## Launcher and validator integration requirements

`JobControl.run` now uses `python -I -c` for its **trusted parent launcher only**.
Without `-I`, top-level `subprocess.py` or `threading.py` in an untrusted cwd runs
before the child reaches sandbox-exec. The child argv and its explicit environment
are unchanged. A marker regression verifies the child runs without importing
either shadow module.

When imported Runtime execution is added, wrap the **entire Popen argv**, including
Runtime's Python launcher, not just uvicorn's inner command. Do not remove the
current non-demo refusal before review. The validation owner must wrap compile,
baseline collection, tests, and boot similarly. Trusted baseline fixtures must
be copied into the private run root, not made readable from another snapshot.

Sandboxed pytest needs `--confcutdir <code>` in addition to `--noconftest`,
`-c /dev/null`, `-p no:cacheprovider` and disabled plugin autoload. Otherwise
pytest walks ancestors from `/` despite `--rootdir`, and correctly fails on
unreadable sibling paths. This flag has been coordinated with Codex 1; do not
broaden filesystem reads to accommodate pytest's ancestor collection.

## Adapter scope

`fastapi_sqlite.ADAPTER` builds fixed, scripted-only sandboxed profiles from the
strict M1 AdapterConfig. No shell commands or arbitrary argv are accepted.
Compilation targets the app's top-level package (or a single top-level `.py`
module); immutable manifest patterns protect matching basenames at any depth,
as agreed with the generation guard owner. SQLite snapshot patterns are recursive.

Preflight is static: bounded regular-file inventory, existing analyzer checks,
configured app/tests/health matching, dependency availability/version checks and
project shadowing rejection. `find_spec` receives **top-level names only**; no
project imports, test collection, package installation or script execution occurs.
An engine import path containing the project is rejected. Source/code bytes and
modification times are checked unchanged by tests.

Supported dependency declarations are simple requirements files and bounded
static PEP 621 dependency lists, with installed compatible engine distributions.
The trusted engine's `packaging` module is needed for requirement/version parsing;
if unavailable preflight fails closed. Extras, URL/editable dependencies,
requirements indirection, dynamic metadata, setup.py/setup.cfg and Pipfile
declarations are rejected rather than installed or guessed. Missing dependencies
return `dependency_unavailable`; project module/package collisions return
`dependency_shadowed`. Initialization creates only empty isolated state; it never
seeds or copies a source repository's local database.

## Review gate and remaining work

Direct sandbox fixtures exercise compileall, legitimate pytest and uvicorn,
SQLite writes, exact-file reports, blocked home/sibling reads, source writes,
symlink escapes, shell exec, external sockets and parent environment inspection.
These are disposable helper tests, not imported-project Runtime activation.

Step 2 is ready for sandbox review only, **not** an imported-project execution GO.
Pending gates: runtime credential fix merged/approved for integration, architect
sandbox review, project trust/import lifecycle, complete Runtime wrapping,
generation integration, restart/cancellation and cross-future isolation tests.
This is a macOS-only sandbox, not a VM or a proof against every kernel/native
exploit; no CPU/RAM quota or protection from other localhost services is claimed.
The profile still starts with `allow default` and explicit restrictions. A later
hardening pass should consider `deny default` with an audited operation allowlist;
that conversion is not part of this reviewed change.

## Verification

On macOS with the engine's Python 3.9.6 environment, with provider and engine
credential variables unset in the test runner:

```
python -m pytest -q tests/test_exec_sandbox.py tests/test_adapters_fastapi_sqlite.py \
  tests/test_exec_sandbox_launcher.py tests/test_runtime_environment.py tests/test_projects_profile.py
# 75 passed in 21.99s

python -m pytest -q tests/test_engine.py tests/test_generations.py \
  tests/test_validation_hardening.py tests/test_isolation_reliability.py \
  -k 'not test_live_droid_generation_records_a_complete_result'
# 104 passed in 145.48s
```

After the Mach-service review fix, the same focused command passes **84 tests in
23.55s**, including the eight denied Mach-service lookups and failed external /
localhost name resolution. Compileall, pytest, SQLite, platform/cpu queries,
uvicorn and its numeric-loopback health probe pass under the final profile.

No paid or live model calls, original-repository execution, UI changes, pushes,
or merges occurred. The full suite is not duplicated here while Codex 1 runs
the coordinated full offline generation gate on its separate branch; its result
is not claimed as a full-suite result for this sandbox commit.
