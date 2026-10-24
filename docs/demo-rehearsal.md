# One-command scripted demo rehearsal

From a checkout with Python 3.9+ and the project's dependencies installed:

```sh
.venv/bin/python scripts/demo_rehearsal.py
```

The command starts a real engine on an OS-assigned loopback port and drives it
over HTTP, using only the existing `scripted` provider and checked-in recipes.
It never invokes Factory or a model; credentials and inherited `PARADOX_*`
settings are not forwarded. Every run uses a fresh disposable state directory
and a separately assigned application-runtime port, so no existing demo is reset.

The rehearsal seeds two contrasting posts over HTTP: an older community favorite
with twelve likes and a newer breaking update with none. It verifies chronological
versus popular ordering, generation without automatic activation, child-only writes,
switching back and revisiting, the ranking source diff, confirmation, decline,
compile failure without a timeline, and cancellation of the five-second slow recipe.
It leaves the confirmed popular future active after successful checks.

Every checkpoint prints `PASS`; errors print `FAIL`, include engine diagnostics,
and exit nonzero. The engine and application runtime stop on success, failure,
or interruption, and temporary state is deleted. No Git files are modified.

For a human walkthrough:

```sh
.venv/bin/python scripts/demo_rehearsal.py --keep-running
```

After the checks pass, the command remains in the foreground with the engine
running. Open its printed app URL (or connect the studio to the same origin).
The printed state directory is available while it runs. Press Ctrl-C to shut
everything down and remove disposable state; do not use this for durable work.

CI-style coverage, without Factory credentials:

```sh
env -u FACTORY_API_KEY .venv/bin/python -m pytest -q tests/test_demo_rehearsal.py
```
