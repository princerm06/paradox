# M1 repository API: final backend contract

Status: final backend handoff, October 24, 2026. Routes and response fields retain
the architect's frozen v1 shape. The user's final M1 request supersedes v1's
in-memory registration rule: IDs and successful configurations are now persistent.
This document is the persistence addendum and exact HTTP integration reference.

## Safety and authentication

- Every repository route requires `Authorization: Bearer <PARADOX_TOKEN>`, including
  GET. If the engine has no token configured, all repository routes return 401.
- POST/DELETE requests with an `Origin` header must match an exact configured
  `PARADOX_CORS_ORIGINS` entry; otherwise 403 precedes token checking. A missing
  Origin is permitted for trusted native/CLI clients, but never bypasses auth.
- GET still requires the bearer token; disallowed browser origins receive no CORS
  read permission. OPTIONS is CORS preflight, not a repository operation.
- Native registration/forgetting additionally requires
  `X-Paradox-Shell-Token: <PARADOX_SHELL_TOKEN>`. An unset shell token returns 403
  `registration disabled`. Keep this token in the native shell, never the page.
- Browser startup roots come from `PARADOX_REPOSITORY_ROOTS` (OS path separator)
  or `create_app(repository_roots=[...])`. Each entry is one repository root.
  No browser path picker or arbitrary-path inspection route exists.
- CORS allows Content-Type/Authorization for GET/POST, not the native shell-token
  header or browser DELETE. Registration/forgetting are native/CLI operations.
- No route imports project code, installs dependencies, runs tests/scripts,
  starts previews, generates futures or writes into the selected repository.
- Keep the engine state directory outside imported repositories. Roots containing
  the engine state directory are rejected as `unsafe_path`, as are roots inside
  that directory; registration cannot make persistence writes in imported source.

The examples use placeholder tokens and an illustrative existing path. IDs and
timestamps are examples, not constants. POST requests use `Content-Type: application/json`.

## Register and list

Native request:

```http
POST /api/repositories
Authorization: Bearer <engine-token>
X-Paradox-Shell-Token: <native-shell-token>
Content-Type: application/json

{"path":"/Users/demo/projects/feed"}
```

Response **201** (`RepositorySummary`):

```json
{"id":"R8j4bTF19Xa_","name":"feed","root":"/Users/demo/projects/feed","source":"picker","registered_at":"2026-10-24T23:00:00+00:00"}
```

`source` is `picker` or `configured`. The root is canonical and absolute. Repeating
registration returns 409, with the existing ID in the error message. Startup
configuration reuses an existing registration instead of changing its ID/source.

`GET /api/repositories` with the bearer token returns **200**:

```json
{"repositories":[{"id":"R8j4bTF19Xa_","name":"feed","root":"/Users/demo/projects/feed","source":"picker","registered_at":"2026-10-24T23:00:00+00:00"}]}
```

An empty list is `{"repositories":[]}`. Summary fields are unchanged; listing a
registration does not imply that its current path or project is available.

## Inspect

`POST /api/repositories/R8j4bTF19Xa_/inspect` with the bearer token and **`{}`**
returns **200**. Omitting the JSON body returns 422; unknown body keys are rejected.

```json
{
  "repository":{"id":"R8j4bTF19Xa_","name":"feed","root":"/Users/demo/projects/feed","source":"picker","registered_at":"2026-10-24T23:00:00+00:00"},
  "git":{"head":"0123456789abcdef0123456789abcdef01234567","branch":"main","detached":false,"dirty":false,"staged":0,"unstaged":0,"untracked":0,"conflicted":0},
  "files":{"tracked_count":4,"sample":["pkg/__init__.py","pkg/main.py","requirements.txt","tests/test_app.py"],"truncated":false},
  "structure":[{"path":"pkg","kind":"dir"},{"path":"requirements.txt","kind":"file"},{"path":"tests","kind":"dir"}],
  "analysis":{
    "schema":"paradox.project-analysis/v1","status":"supported","adapter":"fastapi-sqlite-v1",
    "runtime":{"language":"python","framework":"fastapi","python_requires":null},
    "dependencies":[{"path":"requirements.txt","kind":"requirements"}],
    "candidates":{
      "app":[{"target":"pkg.main:app","path":"pkg/main.py","evidence":"FastAPI() assignment"}],
      "tests":[{"path":"tests"}],"health":[{"path":"/health","source":"pkg/main.py"}],
      "state":[]
    },
    "diagnostics":[]
  }
}
```

The example has no SQLite; projects with SQLite include state candidates
`{"kind":"sqlite","path":null,"env":"PARADOX_APP_DIR"}` (path can also be a
relative literal) and diagnostic evidence. Static analysis does not prove isolation.
Detached HEAD has `branch:null`; an unborn repository has `head:null`.
Tracked-file samples cap at 500 and structure at 200; untracked files are not
analyzed. Git reads are sandboxed and capped at 10000 tracked paths; the analyzer
has a separate 4096-path cap plus bounded file sizes.

## Validate and save configuration

`POST /api/repositories/R8j4bTF19Xa_/validate` accepts **`{}`** or:

```json
{"configuration":{"adapter":"fastapi-sqlite-v1","app":"pkg.main:app","working_dir":".","tests":"tests","health_path":"/health","state_env":"PARADOX_APP_DIR"}}
```

Only `working_dir`, `tests`, `health_path` have defaults (`.`, `tests`, `/health`).
Other fields are required when supplying a configuration. Unknown keys, other
adapters, arbitrary commands, invalid app syntax or another state_env return 422.
M1 restricts working_dir to `.`; test paths cannot escape or use symlink directories.
The app, tests and health endpoint must match static candidates.
Inferred targets outside the adapter's ASCII dotted-module syntax produce
`valid:false` with `configuration_unsupported`, not a startup failure.

Successful response **200**:

```json
{
  "repository":{"id":"R8j4bTF19Xa_","name":"feed","root":"/Users/demo/projects/feed","source":"picker","registered_at":"2026-10-24T23:00:00+00:00"},
  "valid":true,
  "configuration":{"adapter":"fastapi-sqlite-v1","app":"pkg.main:app","working_dir":".","tests":"tests","health_path":"/health","state_env":"PARADOX_APP_DIR"},
  "diagnostics":[{"code":"static_validation_only","severity":"info","message":"No commands executed; runtime, dependency and isolation checks remain required before execution","path":null}]
}
```

An empty request revalidates the saved successful configuration; if none exists,
it infers only when app/test/health candidates are unambiguous. Successful validation
persists the normalized configuration. Invalid validation never replaces it.
`valid:true` is **static compatibility**, not proof that dependencies are installed,
tests pass, the app boots, or database writes are isolated.

Incompatible projects still return **200**, for example a non-Python repository:

```json
{
  "repository":{"id":"R8j4bTF19Xa_","name":"feed","root":"/Users/demo/projects/feed","source":"picker","registered_at":"2026-10-24T23:00:00+00:00"},
  "valid":false,"configuration":null,
  "diagnostics":[
    {"code":"project_type_unsupported","severity":"error","message":"Only statically recognizable Python FastAPI projects are supported by this adapter.","path":null},
    {"code":"configuration_required","severity":"error","message":"Provide an explicit supported adapter configuration","path":null},
    {"code":"unsupported_project","severity":"error","message":"Only the fastapi-sqlite-v1 adapter is supported","path":null},
    {"code":"static_validation_only","severity":"info","message":"No commands executed; runtime, dependency and isolation checks remain required before execution","path":null}
  ]
}
```

The example assumes a clean repository with only a package.json and no prior saved
configuration. Other projects include their corresponding analyzer diagnostics
(for example a missing FastAPI dependency or parse errors). A failed revalidation may return a non-null saved configuration with
`valid:false`; never treat configuration presence as success. Dirty repositories
are allowed, with a `dirty_working_tree` warning. Diagnostics use severity
`error|warning|info` and a relative path or null.

## Persistence and restart behavior

- Paradox writes only its own state file `<state_dir>/repositories.json`, using a
  versioned JSON schema, private 0600 temporary file, file fsync and atomic replace.
  IDs, canonical roots, original source/timestamp and successful configurations survive.
- Startup occurs under the existing engine lifespan/ownership lock. Each persisted
  repository is rechecked through safe path checks, sandboxed Git and the bundled
  analyzer; saved configuration is revalidated, not blindly trusted.
- Missing, moved, permission-denied, symlink-replaced or invalid roots retain their
  IDs in the list. Inspect/validate returns 422 (`repository_unavailable` or a
  Git error) or 503 for unavailable sandbox. No search for moved roots occurs.
  Restoring the original root allows another inspect/validate; otherwise forget
  and register the new location using the native shell.
- Changed project compatibility produces `valid:false`, not a successful import.
  Startup logs code-only warnings and never blocks the existing demo for a bad root.
- Invalid configured roots are skipped; they do not erase saved registrations.
  Removing an env root does not forget it. DELETE is the explicit forget operation.
- Corrupt/unsupported-version/oversize/unreadable/symlink registry files produce an
  empty repository view and code-only warning. Writes fail with `registry_unavailable`
  503; the file is not overwritten. Operator repair is required. Demo/timeline APIs
  remain available. Store limit is 1 MiB.
- `DELETE /api/repositories/{id}` with both tokens returns **204**, no body.
  Forgetting is durable, removes saved configuration, and never deletes source files.
  Reopening the same path after forgetting assigns a new ID.

## Errors and support states

Repository errors use `{"detail":{"code":"unknown_repository","message":"Unknown repository id"}}`.
Authentication/Origin errors use string detail; malformed request schemas use the
standard FastAPI 422 detail array. Error text never includes subprocess stderr.

| HTTP | Codes / meaning |
| --- | --- |
| 400 | `unsafe_path`, `invalid_path` on registration |
| 401 | Missing/wrong bearer token, or PARADOX_TOKEN unset |
| 403 | Foreign mutation Origin, missing/wrong shell token, registration disabled |
| 404 | `unknown_repository` |
| 409 | `already_registered` (existing ID in message) |
| 422 | `unsupported_git_layout`, `unsafe_git_layout`, `unsafe_git_metadata`, `not_repository_root`, `invalid_repository`, `repository_unavailable`, `git_failed`, `git_timeout`, `repository_too_large`, `unsupported_filename`, `unsafe_tracked_path`; or request schema errors |
| 503 | `sandbox_unavailable`, `registry_unavailable` |

| Project state | Meaning |
| --- | --- |
| `supported` analysis | Narrow static Python/FastAPI evidence: single app, declared FastAPI, tests, literal /health, SQLite through an env variable or no SQLite |
| `requires_configuration` | Missing/ambiguous evidence; an explicit config may resolve choices, but cannot suppress error diagnostics or permit non-PARADOX_APP_DIR SQLite |
| `unsupported` | No supported FastAPI evidence, Node/Django/Flask or another unsupported stack; valid:false |
| Unavailable repository | Summary retained; inspect/validate errors instead of making up analysis |

Only `fastapi-sqlite-v1`, single-root Python projects are configuration-supported.
Linked worktrees/submodule Git-file roots, bare Git, external commondir, symlinked
Git metadata, non-UTF-8 filenames and oversized repositories are rejected. No
Linux/Windows Git fallback exists: macOS write/exec sandbox is mandatory. Static
reads are observations, not atomic snapshots. Imported-project execution, actual
state isolation, generation, OAuth, clone/push and PR operations are outside M1.
