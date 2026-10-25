# M2 acceptance gate (revised 2026-10-24 by the user)

Status: **NO-GO** until every REQUIRED row passes on one combined SHA, **in the native macOS desktop app**.
Mocked and scripted results are regression coverage. They are never evidence of real Factory Droid generation.

## Required

| # | Requirement | Evidence |
|---|---|---|
| 1 | Import a supported local Git repository (disposable FastAPI/SQLite fixture, synthetic data) | Desktop picker → register → inspect → validate → trust → import |
| 2 | Compatibility and runtime requirements shown | Inspect/validate results in Studio |
| 3 | Open-ended natural-language request (not a scripted recipe) | Prompt text with no recipe match; scripted provider rejects it |
| 4 | **Real Factory Droid SDK run** inspects the project and writes the change in an isolated future | Live run evidence: session id, model, token/credit usage, agent log, diff |
| 5 | Validation and execution of the future | Compile, pytest and boot results under the execution sandbox |
| 6 | Diff, logs, validation and preview inspectable | Studio evidence panels; preview of the active future |
| 7 | Activate the future, restore the original | Activate then restore; app behaviour and SQLite rows match each timeline |
| 8 | Restart safely | Quit and relaunch the desktop app; timelines, generations and state intact |
| 9 | Scripted generation still works as the fallback | Scripted run on the same build |
| 10 | Mocked Droid regression suites pass | Full Python and Node suites on the combined SHA |

## Security (all required)

- Original repository working tree, `.git` and SQLite database unchanged (hash and mtime before/after).
- Agent writes confined to the isolated future; the guard rejects everything else.
- Host secrets and private configuration protected: the agent cannot read `$HOME` contents, `~/.factory` auth files, engine state or other projects. `FACTORY_API_KEY` reaches only the trusted CLI process.
- **Transmission manifest verified before any live call:** the exact files, prompt, system/project context and environment metadata the CLI would send are captured offline (real CLI, dummy key, local capture endpoint, nothing forwarded) and reviewed by Claude and approved by the user.
- Child-process restrictions and cleanup: generated app and CLI processes cannot fork/detach; every process is reaped on cancel, failure, close, switch, revoke and engine death.
- No open P0/P1 in scope. The documented open P1 (demo code can read the engine launch environment) must be closed for the live-Droid path or explicitly accepted by the user.

## Live-call rules

- No paid Factory call and no transmission of project contents without the user's explicit approval of a specific plan (scope, prompt, repository, cost ceiling, rollback).
- If the live test fails, fix and re-run only with new authorization. M2 is not declared complete on mocks.
- The verified recording ZIP (`Paradox-arm64.zip`, sha256 `977061a6…9595`) is never overwritten. M2 desktop candidates use a different artifact name and output path.

## Desktop native bridge v1 (Studio imported-projects ↔ Tauri shell)

Owner: Claude. Studio side: Codex 3 (`features/imported-projects`). Shell side: Codex 4 (`feat/desktop-m2-candidate`). Changes need all three.

Studio never sees the shell token, the Factory key or a filesystem path it typed itself. The shell owns every OS dialog and every shell-token request.

| Command | Args | Shell behaviour | Resolves | Rejects |
|---|---|---|---|---|
| `select_repository` | none | Unchanged from M1 v1.2 (`m1-projects.md`) | `{cancelled:true}` or `{cancelled:false, already_registered, repository}` | string message |
| `trust_repository` | `{repository_id}` | 1. Validates the id format and fetches the registration over loopback with the bearer (404 means reject). 2. Shows a native confirmation with the canonical root path, the repository name and the current HEAD from `POST /inspect`: "Paradox will run this project's committed code in its sandbox. Your folder is never modified." 3. On confirm, sends `POST /api/repositories/{rid}/trust {"expected_configuration_hash": <hash>}` with bearer and shell token. The hash is the one the dialog was built from, as returned by validate | `{cancelled:true}` or `{cancelled:false, trust:{repository_id, configuration_hash, granted_at, source}}` | string message |

- Studio receives these as an optional `native` adapter. `ImportedProjectsEntry` builds the default adapter from `window.__TAURI_INTERNALS__.invoke` when it is present, so the `App.tsx` mount needs no props. In the browser there is no adapter, and trust stays an operator action.
- The Tauri capability lists exactly these two commands, for the main window and the bundled Studio origin only.
- Not in M2 scope: revoke and delete UI. Reserved names: `revoke_repository_trust(repository_id)`, `delete_project(project_id)`.
- **Trust race (v1.1, agreed with Codex 2):** `POST /trust` accepts optional `expected_configuration_hash` and compares it atomically under the registry lock; a mismatch returns 409 `configuration_changed`. Validate returns `configuration_hash`. Native callers MUST send it; `{}` stays for compatibility only.
- Factory consent is separate from trust and lives in Studio, per run. Trusting a repository never authorizes transmission to Factory.

## Desktop M2 candidate engine mode and credentials (v1.1, agreed with Codex 2)

- `PARADOX_PROJECTS_ONLY=1` (trusted engine setting): no legacy demo engine/generations startup. `/api/timelines`, `/api/generations`, `/api/agents` and `/app` return 503 `demo_execution_disabled`; health, repositories and projects work. The Keychain credential mode REQUIRES it. This closes the documented open P1 for the candidate build, because no unsandboxed generated code runs in that engine. The default demo and the recording build are unchanged.
- Factory key: a signed native credential launcher reads the macOS Keychain item **service `paradox-factory-api-key`, account = the login user name** (the existing item; no new item), applies the full CLI sandbox profile in-process, then execs the hash-pinned CLI with the key in its environment only. Engine, broker, Node and page never hold the key.
- CLI and wrapper pins: `PARADOX_DROID_CLI_EXECUTABLE`/`_SHA256` and `PARADOX_DROID_CLI_WRAPPER_TEMPLATE`/`_SHA256`, prebuilt at package time. No compiler or PATH fallback in pinned mode.
- Agent work is staged under a clean 0700 root in `/private/var/tmp`, guard-verified and published atomically into the future. The ancestor-config rejection is not relaxed.
