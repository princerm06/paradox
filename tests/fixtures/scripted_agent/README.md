# Scripted generation recipes

These offline fixtures implement the frozen M2 contract in
`docs/contracts/m2-generation.md`. Codex 2 owns fixture data; Codex 1 owns the
scripted provider, guard, timing/cancellation, and generation lifecycle.

Set `PARADOX_SCRIPTED_RECIPES` to this directory (prefer an absolute path when
launching from another directory). Use `provider: "scripted"` in generation
requests. No Factory CLI, API key, network, or live coding model is required.

Every JSON document has `match`, `delay_s`, `summary`, and `files`. Relative file
paths are resolved below the generated code directory. A string writes the
complete file; `null` deletes it. The first matching recipe in filename order
wins, using case-insensitive substring matching. Avoid combining multiple recipe
keywords in a demo request.

| Recipe | Exact matching phrase | Expected outcome |
| --- | --- | --- |
| `popular_feed.json` | `popular` | Success: real ranking source replacement plus a new regression test |
| `broken.json` | `break the app` | Compile failure: syntax-invalid `ranking.py` |
| `failing_test.json` | `failing test` | Test failure: one intentional failing new test |
| `delete_test.json` | `delete a test` | Guard failure: deletes protected `demo_app/tests/test_feed_contract.py` |
| `slow.json` | `slow` | Five-second cancellable delay, then a harmless module and passing new test |

The base validation suite has **18 tests**. Successful recipes add one test, so
`popular_feed` and `slow` produce 19 passes. `failing_test` produces 18 passes and
one failure. `broken` and `delete_test` must be rejected before pytest. The broken
recipe intentionally omits a feature test so the only edit is the compile error;
the guard must not reinterpret it as a test-deletion case.

The suite is self-contained under `demo_app/tests/`; only this directory needs to
travel with the application. Validation from copied code, using the engine's
current interpreter and a report path **outside** code:

```sh
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest -q -p no:cacheprovider -c /dev/null --rootdir "$PWD" demo_app/tests --junitxml /outside-code/tests.xml
```

It ignores repository pytest config, requires no plugin autoload, and uses only
temporary SQLite databases. It passes unchanged with chronological and popular
implementations. The generated popularity test specifically proves that older,
more-liked content beats a newer post without mutating either post.

Repository-level fixture tests live in `tests/demo/test_scripted_recipes.py`.
They copy only `demo_app/` to a temporary workspace, apply each file overlay,
compile and run the isolated suite with a credential-free environment, and check
JUnit counts. They do not implement the production provider or wait five seconds
for `slow`; the engine tests own delay/cancellation coverage. Running these tests
does not require the M2 engine changes.
