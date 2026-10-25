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
