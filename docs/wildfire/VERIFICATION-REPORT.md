# Primary wildfire demo — final verification report

## Deliverables and media verification
- Final MP4: `/Users/princem/Movies/paradox-primary-wildfire-20261025.NIusOG/Paradox-NASA-Wildfire-Primary.mp4`.
- Duration: **223.12 seconds**; 1600×900; H.264 High / yuv420p; 25 fps; **zero audio streams**.
- Size: **15,557,434 bytes** (14.84 MiB). SHA-256: `757396c0372ce5e44522c9670c6f2fbe39e49561a4067c52e8a6154dc98be22d`.
- Entire final video decoded by FFmpeg with exit code 0 and an empty error log. Chrome loaded and played it successfully with no media error.
- Browser verification extracted 34 representative frames across all 17 scenes. Actual scene frames are in `review-frames/`; visual review is recorded separately in `VISUAL-REVIEW.md`.
- Timed human narration: `NARRATION-SCRIPT.md`. Executed scenes/prompts/IDs/click coordinates/recovery: `RECORDING-SCRIPT.md`. Both follow the exported edit; the MP4 itself is silent.
- The approximately 3:43 full walkthrough deliberately keeps evidence dwell, following the latest request not to rush. It exceeds the initial approximate 2–3 minute target and the public three-minute pitch description; do not call it a compliant three-minute cut.

## Exact source and isolation
- Base revision: `6ecd978dec64cc419ea53faadb9f3e0c3abcf6df`; branch `demo/nasa-wildfire-primary`. Worktree: `/Users/princem/.t3/worktrees/paradox/demo-nasa-wildfire-primary`.
- Workload/recording adaptations remain uncommitted; this is not a new invented source revision. `source-manifest.json`, `SOURCE-PATCH.diff`, and `workload-and-recorder.zip` identify and preserve the exact additions/changes.
- No engine or Studio product source changed. Existing application tests and AGENTS.md compare byte-for-byte with the base. Feed routes, SQLite schema, parameterized writes, health and smoke behavior remain intact.
- Only new isolated loopback services and disposable state were used. No paid provider, cloud provisioning, public deployment, push, merge, release, or protected recording environment was used for implementation.
- Authoritative final take: `/Users/princem/Movies/paradox-primary-wildfire-20261025.NIusOG/take-5MRjnT`. Its verification.json contains real records, validation, patches, logs, model outputs, active-state milestones and recorded mutations. No browser errors or forbidden-origin/provider violations occurred.

## Dataset and measured model results
- Genuine frozen NASA FIRMS VIIRS export: 1,198 rows / 98,719 bytes. Retrieved 2026-10-25 07:18:21 UTC; observations 2026-10-24 06:50–21:38 UTC.
- SHA-256: `66a3b9ea2f099b04d795292450a84710f57a17e0a23bfafc57b22e9ae82cd9c6`. Fixed timestamp-group split: 1,129 train / 69 held-out rows. Complete attribution/schema/units/filtering/limitations: `DATASET.md`.
- Target: contemporaneous fire radiative power in MW from same-time brightness temperature in K, not wildfire spread, evacuation, or emergency deployment. The holdout is used for selection, not an untouched final generalization assessment.

| Actual model | MAE MW | RMSE MW | R² | Train ms | Batch inference ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original · train mean | 8.356204 | 24.366925 | -0.099221 | 0.407750 | 0.005084 |
| Model A · brightness OLS | 8.395625 | 22.254659 | 0.083093 | 0.854292 | 0.006416 |
| Model B · engineered ridge | 7.986002 | 21.725393 | 0.126186 | 4.343208 | 0.050875 |

Original is a training mean; A genuine OLS; B training-scaled polynomial ridge. A slightly worsens MAE against Original while improving RMSE. B has lower errors on this small selection set only. No fabricated winner or timing is used; process timings vary.

## Genuine generations and security ancestry

| Future/attempt | Generation | Parent timeline | Adopted timeline | Result | Tests |
| --- | --- | --- | --- | --- | --- |
| Model A · Linear | `007444dc-6956-4840-86c5-d99f53e6072f` | `ce95e65d-5f75-4050-9c37-cd45aa49297a` | `98541f67-f4da-4528-ac20-c0fc4c5b887e` | succeeded | 21 passed / 0 failed |
| Model B · Ridge | `3568fc76-1b19-4932-954f-e46b84c7deb3` | `ce95e65d-5f75-4050-9c37-cd45aa49297a` | `8616d0f9-d822-4457-803c-8352e14de73b` | succeeded | 21 passed / 0 failed |
| Input experiment | `2d6ef923-abb7-4190-8fc7-77a386b61d5e` | `8616d0f9-d822-4457-803c-8352e14de73b` | `59adbbcd-02c8-454a-a23d-a3f83817d1cd` | succeeded | 22 passed / 0 failed |
| Reject invalid input | `f2dd0ee3-83f3-4819-b6ef-dbbf819bf860` | `59adbbcd-02c8-454a-a23d-a3f83817d1cd` | `None` | failed | 23 passed / 1 failed |
| Hardened input | `96ab718e-03c9-416e-8c7c-4f6c66ed04f8` | `59adbbcd-02c8-454a-a23d-a3f83817d1cd` | `5da57337-9718-499c-8d86-24659b25a0b1` | succeeded | 24 passed / 0 failed |

- All shown generations use Scripted with actual patches, not a simulated Factory response. Successful candidates pass all six engine checks.
- Unsafe and hardened predictions run only fixed-size arithmetic. The failing test genuinely observes 200 instead of required 422; its attempt is retained but never adopted. The hardened future is a real child of the unsafe timeline, not of the failed attempt.
- Failed and hardened recipes add byte-identical security tests, SHA-256 `6dd2d1d6056433680ebf5c0a64833c67fa1e172983eb27f909a21f8e7a92b6a4`. Hardened activation demonstrates invalid 422 and legitimate 200. This is a scoped local input-validation regression, not penetration testing or general security assurance.
- Original `ce95e65d-5f75-4050-9c37-cd45aa49297a` restored from saved snapshot `66945cdb-c12e-4bcd-9746-1369b4f37eb6`. Exact posts equality proves saved SQLite state restoration; restored model ID is original. Five successful timelines remain; the failed attempt has no timeline.

## Tests executed and non-green regressions
- Original app: 20 passed. Actual engine: A/B 21 passed each; unsafe 22 passed; failed security attempt 23 passed / 1 deliberately failed; hardened 24 passed.
- Studio: typecheck passed; 90 tests across 12 files passed; production build passed. Lint: zero errors, 36 existing warnings. Build also reports the existing large-chunk advisory.
- Broad backend run: **476 passed / 8 failed / 6 skipped**, 655.31 seconds. This run is NOT presented as fully green. Full output: `backend-regression.log`.
- One stale HTML compatibility failure was repaired with an actually used request helper. Fresh targeted rerun: **35 passed / 1 failed** across app tests, demo API tests and the isolated trust assertion; `targeted-regression.log`.
- Five failures are fixed historical test-count assertions: three default-recipe tests expect 19 instead of the actual 21; legitimate popular-feed hardening expects 19 instead of 21; collection-tampering expects 1 collected survivor instead of 3 after two new workload tests. The tampering still fails closed before its obsolete count assertion. No trust or validation control was relaxed.
- One old HTML-restoration fixture replaces the literal old title `The Feed` with `The Future Feed`; the new workload intentionally no longer contains that title. Actual source/model and SQLite restoration pass in the final engine/UI take.
- The configured-trust caplog assertion also fails independently on an untouched `6ecd978` source archive in the same local interpreter (`baseline-trust-test.log`). It is a baseline/environment failure, not claimed fixed. No core changes or test weakening were made.
- Existing immutable tests remain untouched. These six adaptation-specific fixture incompatibilities and the baseline failure are disclosed, not erased or reported as passing. `git diff --check`, Python compile and recorder JavaScript syntax checks passed.

## Protected assets and fallback
- SHA-256 recheck: **843 existing files**, no missing or modified files across all four protected recording environments; `preservation-before.json` / `preservation-after.json`.
- The latest backup and its Downloads copy both retain SHA-256 `49d04a61f3c5f9d4d8f741c74a86b60e88caf36d933b3e939bbaf75e705bcd6f`; `downloads-backup-before.sha256` / `downloads-backup-after.txt`.
- Original checkout, approved redesign worktree and portable application were not edited. Existing backups remain the fallback; this primary output is in a separate Movies directory.

## Sponsor evidence and omissions
- Microsoft: real developer-workflow/usefulness evidence, not Microsoft platform integration.
- SpaceXSI: actual NASA data plus actual Cursor composer-2.5 UI implementation task evidence.
- Factory: implemented SDK adapter and clearly identified repository-documented historical success; no recovered raw historical artifacts and no fresh paid or wildfire Factory run.
- Armadin: real limited input-validation failure/remediation; Figma: approved design-to-working-Studio evidence.
- Atlassian: no real Forge app; omitted as a qualifying integration. No Grok Bot, institutional endorsement, unrestricted framework support, native Tauri execution, or production emergency prediction is claimed.
- Sponsor eligibility is not certified. Detailed requirements/evidence/missing items: `SPONSOR-EVIDENCE.md`; pitches and current/future distinction: `SUBMISSION.md`.

## Artifact index
- Final video; NARRATION-SCRIPT.md; RECORDING-SCRIPT.md; captions.srt.
- media-verification.json; media-probe.txt; full-decode.log; playback-verification.json; review-frames/; VISUAL-REVIEW.md.
- Final take verification.json, shots/, engine/studio logs, disposable engine state and raw WebM.
- DATASET.md; SPONSOR-EVIDENCE.md; SUBMISSION.md; source-manifest.json; SOURCE-PATCH.diff; workload-and-recorder.zip.
- Regression/build/typecheck/lint logs and preservation reports remain in this artifact root.
