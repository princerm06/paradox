# Projects M2-B, step 1: demo profile injection

This is the first, demo-only delivery from the frozen Projects M2 v1 contract at
`c639ba2`. It does not implement imported-project execution or new project APIs.
The branch starts at M1 `7c79aa6`, includes the exact contract/base-profile commits,
and includes the independent runtime and preview credential fixes from
`bbc568d` and `153ed1e`. No shared adapter interface has been changed.

## Profile plumbing

- `Engine(..., profile=DEMO_PROFILE)` stores the profile and passes the same object
  to `Runtime` and `Storage`.
- `Runtime(..., profile=DEMO_PROFILE)` takes its uvicorn target, readiness path and
  state environment variable from the profile. The target is a distinct launcher
  argument, not interpolated Python or a shell command. Existing port reservation,
  process lifecycle and credential scrubbing are unchanged.
- `Storage(..., profile=DEMO_PROFILE)` backs up the declared SQLite glob matches
  with SQLite's backup API and removes snapshot WAL/SHM/journal sidecars. Patterns
  cannot escape the state directory. Duplicate matches are backed up once;
  matching directories are rejected, not silently treated as databases.
- Restart recovery derives the Python module path from the target and checks
  explicit database filenames declared by the profile. Wildcard patterns do not
  imply that every possible database extension must exist.
- Initial package placement and the demo-only popularity template derive their
  package path from the profile. Legacy demo `behavior.json` initialization and
  its chronological default are intentionally unchanged.

`DEMO_PROFILE` retains exactly the existing app target, `/health`, state variable,
single `app.sqlite3` backup rule and demo package. The database schema, public API,
timeline transitions and bundled demo source are not changed.

## Execution is still closed

Only `execution="trusted_local"` with the bundled `demo-v0` adapter can start a
runtime in this delivery. Sandboxed, unknown and non-demo trusted-local profiles
fail before process launch. Demo workspace initialization rejects non-demo
adapters, including attempts to start them through `Engine`.

The recursive SQLite tests exercise private, disposable state only; they do not
authorize imported applications to run. The execution sandbox, adapter preflight,
HEAD import, explicit trust, project registry and project-specific routes belong
to later reviewed steps. No repository scripts, installs, imported code or paid
agent calls are run by this step.

## Gates

`tests/test_projects_profile.py` covers default/explicit profile propagation,
demo switching and checkpoint restoration across restart, profile-controlled
runtime target/readiness/state variable, fail-closed runtime and engine startup,
recursive SQLite WAL-backed snapshots and restoration, traversal patterns and
database-directory rejection. Existing isolation, environment, scripted generation
and HTTP rehearsal tests remain the compatibility gates.

The full offline Python suite is run with provider credentials unset and the paid
live-Droid test excluded. Desktop and browser Gate A verification remain with
Claude; passing Python tests alone does not claim those independent gates passed.
