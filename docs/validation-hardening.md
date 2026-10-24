# Generated-test validation hardening

Generated test runs disable conftest discovery (`--noconftest`), configuration
discovery (`-c os.devnull`), cacheprovider, and third-party plugin autoload.
The baseline currently contains a client fixture in `demo_app/tests/conftest.py`.
The engine explicitly loads that one immutable **base snapshot** file as a plugin;
it never discovers or loads a generated conftest. This retains the existing
18-test contract and lets legitimate generated feature tests use its fixtures.

The guard rejects changes to conftest, pytest/configuration files, Python startup
hooks and `.pth` files, and Python identifiers named `pytest_plugins`. It rejects
agent-created `__pycache__` directories and `.pyc` files before compilation,
including unchecked-hash bytecode. Rejection rather than silent removal makes
these attempts visible as guard failures, with no adopted timeline. Snapshot
copying already excludes bytecode, so the working copy starts cache-free.
Bytecode produced subsequently by the engine's compiler is not agent input.

These checks are defense in depth, not an OS security sandbox. Generated Python
still executes with the engine user's local permissions; deliberately hostile
application/test code could tamper with pytest, reports, or other host files.
Run untrusted agents only in a disposable, credential-free OS sandbox. No claim
is made that a path/content guard can securely validate arbitrary hostile Python.
