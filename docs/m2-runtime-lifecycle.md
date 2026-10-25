# M2-B runtime integration

Imported profiles launch the entire isolated Python process through the reviewed
execution sandbox. Only workspace state and a private runtime temporary directory
are writable; the readable run root is the workspace, not the engine state root.
The original repository is never passed to Runtime. Health checks use the profile
path on `127.0.0.1`; DNS, including `localhost`, is unavailable in the sandbox.

The engine drains child stdout through a pipe into its bounded runtime log.
Passing the engine-owned log descriptor directly is insufficient: the sandbox
correctly denies writes to that file outside the workspace. A trusted stdlib-only
`python -I` supervisor runs outside the application sandbox and never imports
repository code. It owns the sandboxed application's session and watches an
engine-owned liveness pipe; the application gets `/dev/null` as stdin, not that
pipe. Application `exec` cannot remove this external watchdog. Engine death,
close and cancellation trigger TERM, followed by KILL after one second if needed.
Stopping waits for supervision before snapshotting state, closes descriptors and
removes temporary data. Sandboxed snapshots contain
only code and application state, never runtime temporary files.

`Runtime.start()` raises `RuntimeError("execution_sandbox_unavailable: " + reason)`
before creating a child when the enforcement probe fails. The Projects API maps
that prerequisite failure to 503. Default demo profiles retain their launcher,
health endpoint and initialization semantics.

Initial targeted gate: 29 passed (project runtime, engine and runtime credential
tests). Probes use dummy credentials and disposable repositories only. They cover
HTTP serving, SQLite writes/restart, source/Git identity, credential absence,
code write denial, sibling/home read denial, outbound/DNS/shell/Mach denial,
engine environment and signal denial. This is a runtime gate, not complete M2 GO.

## User-approved single-process boundary

The user explicitly narrowed imported compatibility on October 24, 2026 after
the detached-child cleanup P1. This supersedes the earlier contract's permission
for confined interpreter children; it does not change adapter method signatures.
The application sandbox now denies `process-fork`, including fork, posix_spawn,
subprocess and multiprocessing. Mach brokers, shell execution and unauthorized
interpreters remain denied. The availability probe verifies fork and posix_spawn
are denied; enforcement failure prevents imported execution with 503.

Only one supervised application process is supported. Python threads remain
available for FastAPI/SQLite. Approved-interpreter exec-in-place is permitted,
retains the sandbox/session, and cannot escape external supervision. Workers,
reloaders, subprocess tests, shell helpers and indirect subprocess creation are
unsupported. The trusted engine, scripted agent and JobControl launchers stay
outside this application-only restriction; bundled demo behavior is unchanged.

The former strict-xfail detached-child reproduction is replaced by passing
worker-rejection tests. Additional real HTTP cases attempt detached spawn before
re-execing a TERM-resistant state writer, then close, switch projects or revoke
trust. Crash, boot cancellation and unhealthy-start timeout tests also verify the
application dies and runtime temporary data is removed. Final counts and the
release decision are recorded in `docs/m2-projects-api.md` after the final gates.

## Validation supervision

Fork denial alone is not sufficient for validation: a sandboxed process sharing
its launcher's session could detach itself with `setsid()` without forking. All
JobControl commands therefore use the same trusted isolated supervisor, and each
command starts as its own session leader. The kernel then rejects both `setsid`
and changing that leader's process group; approved-interpreter exec retains those
properties. An engine-owned, separately inherited pipe is monitored by the trusted
supervisor only. Cancellation, timeout and engine death TERM/KILL the command's
session-leading process group and reap it. This does not apply the application
sandbox to trusted jobs or agents: their original argv, environment, stdin payload,
stdout and ability to create subprocesses remain available. JobControl's public
call signature is unchanged. A separate trusted-job test verifies subprocess
creation and input payload delivery still work.

New hostile JobControl tests re-exec a TERM-resistant state writer, assert session
and process-group escape fail, and prove PID termination plus stable state after
cancel, timeout and engine-pipe EOF. Runtime processes use the same supervisor but
keep application stdin separate from the engine-liveness channel.
