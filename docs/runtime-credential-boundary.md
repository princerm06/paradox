# Runtime credential boundary

Live application code includes adopted, generated code. It must not inherit the
engine's credentials. `Runtime` now defaults to `jobs.scrubbed_environment()`:
only the host `PATH` and `HOME`, plus the existing Python/pytest safety flags.
The runtime still sets its private `PARADOX_APP_DIR`, disables bytecode writes,
enables unbuffered output, and removes `PYTHONPATH`.

Explicit environment mappings remain supported for validation and adapter
settings. They are copied, not mutated. `FACTORY_API_KEY`, `PARADOX_TOKEN`,
`PARADOX_SHELL_TOKEN`, and `ANTHROPIC_API_KEY` are removed even from these mappings.
Other explicitly supplied values are trusted caller configuration; do not pass
`os.environ` as an explicit mapping.

The `/app/` preview proxy also strips `Authorization` and
`X-Paradox-Shell-Token` request headers case-insensitively. Previously, forwarding
these headers let application code receive engine credentials whenever a client
attached them to a preview request, independently of subprocess environments.
Application cookies and other ordinary headers remain intact. Provider keys are
not accepted over the engine HTTP API; this is not a guessed provider-header
denylist.

## Subprocess audit

Audited against base `5bdecc5`, with the M1 Git runner inspected separately on
`feat/local-repository-m1` at `7c79aa6`.

| Boundary | Environment source | Credential policy |
| --- | --- | --- |
| Live `Runtime` (including Engine activation/restart) | Scrubbed default or explicit mapping with credential removal | No application/engine/shell credentials |
| `JobControl.run`, compile launcher | Scrubbed default; its nested subprocess inherits the same mapping | No credentials by default; explicit environments audited below |
| Scripted provider | No provider subprocess | No credential forwarding |
| Provider Node version and SDK availability probes | `scrubbed_environment()` | No credentials |
| Droid provider agent | `scrubbed_environment("droid")`, then sandbox preparation | Only this agent path retains `FACTORY_API_KEY`; no bearer/shell/Anthropic keys |
| Immutable baseline test collection and generated tests | Scrubbed environment plus private `PARADOX_APP_DIR` | No credentials |
| Validation boot/smoke runtime | Explicit scrubbed environment, also filtered by Runtime | No credentials |
| Droid sandbox platform probe | Fixed `PATH` only | No credentials |
| Droid sandbox enforcement probe | Prepared agent mapping minus `FACTORY_API_KEY` | No credentials |
| M1 repository Git subprocess | Fresh fixed Git environment with private HOME/TMPDIR and hardened config flags | No credentials; kernel write/exec restrictions |

The SDK's own child processes inherit the Droid provider mapping, not the engine
environment. `JobControl.run` and sandbox preparation are internal APIs accepting
explicit environments; they are not independent general-purpose secret filters.
Their current callers use the sources above.

`engine/droid_adapter/verify_live.py` is a separate opt-in, paid verification
harness. It inherits the operator environment when launching the **control-plane
engine**, not application or agent code. The engine needs its bearer token and
provider credentials; its application subprocess is now scrubbed. The harness was
inspected only, not executed or modified.

## Regression coverage and limits

`tests/test_runtime_environment.py` sets all four sentinel credentials and an
unrelated private variable in the parent. A disposable app records environment
**names only** from inside the real runtime process. Tests cover Engine startup,
sprout, return to parent, revisit child, and direct Runtime default/explicit
environments. Explicit legitimate app settings survive; the caller's mapping is
unchanged. Runtime processes are stopped in `finally` blocks. No production probe
route is added.

Additional tests exercise a scripted generation through compilation, immutable
baseline collection, pytest, validation boot/smoke, adoption and the actual
`/app/` preview. Child-side assertions reject all four sentinel names. A local
Python mock replaces the Droid executable and proves that only that explicit
agent path receives the dummy Factory key, never bearer/shell/Anthropic keys;
neither the real SDK nor a paid call is involved. Preview header tests use a
disposable fixture route reporting presence booleans only, including mixed-case
names, and prove that cookies and application headers survive.

This fixes environment inheritance, not arbitrary hostile-code isolation. `HOME`
is still inherited by the bundled demo, and this change does not block filesystem
reads, same-user process inspection, network access, or secrets deliberately
written into code/state. Imported-project execution must remain disabled until
the separately reviewed execution sandbox is available. Its `environment()` must
start from `scrubbed_environment()` and test the same sentinel exclusions.
