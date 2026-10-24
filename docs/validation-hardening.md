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

The tests stage requires exit code zero **and** a regular, non-symlink, parseable
JUnit report with consistent suite/testcase counts, no failures/errors, and at
least the immutable baseline's test count executed. Skipped cases do not count.
An early `os._exit(0)` with no report is a tests-stage failure, not a pass. Reports
use engine-owned, random `tests-<uuid>.xml` paths instead of predictable names.

For each generation the engine collects the baseline exactly once with pytest
`--collect-only` in a fresh disposable copy of **base/code**, never the generated
tree. A trusted engine-supplied plugin counts `session.items`, including parameter
expansions. This collect-only pass uses the same conftest/config/plugin restrictions
and isolated app state; it must exit successfully and record a positive count.
The original snapshot is not imported from or modified, except that its immutable
fixture file is explicitly loaded as described above. This deterministic count
sets the minimum executed-test floor, so generated code cannot lower it by hiding
the baseline during its own collection. Additional generated tests can increase
the executed count but never reduce that floor.

These checks are defense in depth, not an OS security sandbox. Generated Python
still executes with the engine user's local permissions; deliberately hostile
application/test code could tamper with pytest, reports, or other host files.
Forging a plausible complete report plus exit zero remains possible from arbitrary
generated Python. Random report names reduce predictable-path planting but are
not a security boundary: the subprocess can inspect its arguments and filesystem.
Boot and HTTP smoke checks run independently after the tests gate succeeds;
pytest exit/report manipulation alone does not bypass those runtime checks.
Run untrusted agents only in a disposable, credential-free OS sandbox. No claim
is made that a path/content guard can securely validate arbitrary hostile Python.
