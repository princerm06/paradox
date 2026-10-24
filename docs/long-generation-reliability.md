# Long scripted-generation reliability check

```sh
env -u FACTORY_API_KEY PARADOX_LONG_GENERATION_TEST=1 \
  .venv/bin/python -m pytest -q tests/e2e/test_long_generation.py
```

This opt-in backend test takes about four minutes. It uses a disposable local
recipe with a 270-second delay and the unmodified scripted provider; it never
invokes Factory or a real model. The usual offline suite skips it to stay fast.

Over real engine/application HTTP it starts generation from the root, writes to
the root, switches to a separate existing future, writes there, confirms that
future during generation, and returns to the root. It verifies the generation's
code/SQLite copy retains the original snapshot rather than either subsequent
write. For four minutes it checks the active timeline, preview behavior, and
absence of ghost timelines. It revisits the confirmed child, cancels generation,
restarts the engine, and proves cancellation, both databases, and source behavior
survive. Existing acceptance-harness cleanup owns all spawned processes.

This is an offline scripted-delay reliability check, not evidence about Factory
SDK streaming, paid model latency, or frontend animation behavior.
