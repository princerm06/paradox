# M2-B runtime integration

Imported profiles launch the entire isolated Python process through the reviewed
execution sandbox. Only workspace state and a private runtime temporary directory
are writable; the readable run root is the workspace, not the engine state root.
The original repository is never passed to Runtime. Health checks use the profile
path on `127.0.0.1`; DNS, including `localhost`, is unavailable in the sandbox.

The engine drains child stdout through a pipe into its bounded runtime log.
Passing the engine-owned log descriptor directly is insufficient: the sandbox
correctly denies writes to that file outside the workspace. The stdin watchdog
uses an unbuffered descriptor read to avoid buffered-reader shutdown deadlocks.
Stopping a runtime terminates its process group, including surviving descendants,
then closes descriptors and removes temporary data. Sandboxed snapshots contain
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
