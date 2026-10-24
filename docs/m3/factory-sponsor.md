# Factory Droid SDK: sponsor-track evidence

Status as of 2026-10-24, after the successful third live run. Every claim is tagged **Verified** (checked against a primary source or our own code and runs), **Reported** (from a secondary source, not yet confirmed) or **Assumed**.

## 1. What the sponsor track asks for

| Claim | Status | Source |
|---|---|---|
| Factory is a Cal Hacks 13.0 sponsor | **Verified** | calhacks.io sponsor list includes Factory (factory.ai). Factory's CTO, Eno Reyes, is listed as a speaker. |
| Cal Hacks 13.0 has a "[Factory] Best Use of the Factory Droid SDK" prize ($2,000 cash, 1 winner, plus Factory credits and swag) | **Reported** | Search-engine summary of the cal-hacks-13-0.devpost.com listing. The page itself returned 403/429 to automated fetches. |
| Criteria: use the Droid SDK (TypeScript or Python) in a meaningful way; Droid performs real tasks *inside the running product*, not only to help write code; the repo README explains where and how Droid is used | **Reported for HackHarvard 2026** (same prize name). **Assumed** for Cal Hacks. | hackharvard2026.devpost.com, via a search summary |
| Exact Cal Hacks submission deadline and required artefacts (video, repo link, etc.) | **Unknown** | Not retrieved |

**Action for a human:** open https://cal-hacks-13-0.devpost.com/prizes in a browser and paste the Factory prize text into this file. Until then, treat the criteria above as likely but unconfirmed. Do not claim eligibility in the submission without them.

## 2. How Fork meets the reported criteria

| Reported criterion | What Fork does | Status |
|---|---|---|
| Uses the official SDK | `engine/droid_adapter` uses `@factory/droid-sdk` **0.10.0** (`@factory/droid-sdk/node`), pinned via lockfile. Calls: `listModels`, `createSession`, `session.updateSettings`, `session.listTools`, `session.stream`, `session.close`, plus `permissionHandler` and `abortSignal`. | **Verified** in code (`src/adapter.ts`), with mocked tests |
| Droid does real work inside the product | Users type a request in Fork's UI. Droid edits a *copy* of the running app in an isolated future, and Fork validates, boots and adopts the result as a new switchable timeline. Droid is part of the product's runtime, not a dev-time helper. | **Verified live**: run 3 adopted a Droid-written future (see section 3) |
| README explains Droid usage | `README.md` § "How the Factory Droid SDK powers AI-generated futures", plus `engine/droid_adapter/README.md` and `VERIFICATION.md` | **Verified** (main) |
| Provenance | Every generation records the SDK `sessionId`, duration, summary, token usage and `factoryCredits`, the event log, the diff and the evaluation | **Verified**: three real sessions recorded (`c73bc85d…`, `58455bca…`, `9314e994…`) |

## 3. Live evidence

| Run | Model / mode | Outcome | Credits | Root cause |
|---|---|---|---|---|
| 1 (`bd3c06b0`) | gpt-6.1-sol / `script_only` | failed: guard, no changes | 5,222 | `Script` was disabled; in `script_only` mode that removes every tool |
| 2 (`f98456d7`) | claude-sonnet-4-6 / `direct_only` | failed: guard, no changes | 133,563 | Under `AutonomyLevel.Off`, Edit/Create were `allowed:false`, which means *hidden from the model*. Droid read the code and wrote the change in prose. |

| 3 (`1c98d768`) | claude-sonnet-4-6 / `direct_only`, Autonomy Off + `enabledToolIds: [Read, Edit, Create]`, macOS write sandbox | **succeeded** and adopted as timeline `e707847b` | 42,278 | n/a |

**Run 3 evidence** (built from `integration/m3` @ `6731c50`, the same code as PRs #10, #9, #12 and #13). The raw files are kept locally in `paradox-worktrees/m3-integration/.venv/droid-proof-3/`, which is git-ignored and never committed.
- **Checks before the model turn:** model `claude-sonnet-4-6`, `direct_only`, autonomy `off`. After enabling: Read, Edit and Create all `allowed=true`.
- **Tool calls:** 5× Read, 2× LS, 1× Edit, 1× Create. **The permission handler was called twice and approved both writes** (both inside `demo_app/`).
- **Diff:** `demo_app/ranking.py` (+2/−2: `ORDERING = "popular"`, sorted by `(likes, created_at, id)` descending) and a new `demo_app/tests/test_popular_ranking.py` (+75, 7 tests).
- **Validation:** agent, guard, compile, tests (26 passed, 0 failed), boot (295ms) and smoke all passed.
- **Adoption:** timeline `e707847b`, `modification: "ai"`, `generation_id` linked.
- **Isolation:** the child orders by popularity and the parent stays chronological. A parent write made after generation is absent from the child; a child-only write survives a revisit.
- **Integrity:** the parent `ranking.py` hash is unchanged; repo tracked files are unchanged; no sandbox denials; no key-like strings in any evidence file.
- **Session:** SDK session `9314e994`, 26.7s agent time, 1 HTTP generation request.

Runs 1 and 2 are kept as an honest record. They show real SDK sessions and fail-closed validation, and their root causes are fixed in PR #13.

## 4. Pitch-safe wording

Safe: "Fork's AI futures are written by Factory Droid through the official TypeScript SDK. Each future records Droid's session, cost and diff, and only becomes a timeline after Fork independently compiles, tests and boots it."

Now safe (run 3): "We generated a real future live with Factory Droid. It edited the code, Fork's own permission handler approved each write, and the result passed 26 tests and booted before becoming a timeline."

Still not safe: "we are eligible for / will win the Factory prize" (the prize text is still only reported, see section 1), and claiming any *specific* on-stage run succeeded before it has.

## 5. Official SDK references checked

- TypeScript SDK: https://github.com/Factory-AI/droid-sdk-typescript (README plus `docs/typescript-sdk-reference.md`). It documents `autonomyLevel`, `permissionHandler` and subtractive `disabledToolIds`. It does **not** document enable/allowlist tool controls ("does not expose a restrictive allowlist").
- Python SDK: https://github.com/Factory-AI/droid-sdk-python. It documents `SessionConfig`/`update_settings()` with **all four** native-tool controls: `additional_tools`, `enabled_tools`, `disabled_tools` and `restrict_tools`. This is first-party evidence that explicit tool enablement is a supported Factory capability. The TypeScript 0.10.0 public types omit it, although the wire protocol accepts it.
- Docs: https://docs.factory.ai (redirects to docs.factory.com).
