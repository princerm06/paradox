import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile


REPO = Path(__file__).resolve().parents[2]
OUTPUT = Path((REPO / '.primary-demo-output').read_text().strip())


def read_json(name):
    return json.loads((OUTPUT / name).read_text())


def git(*arguments):
    return subprocess.check_output(['git', *arguments], cwd=REPO)


def package():
    media = read_json('media-verification.json')
    playback = read_json('playback-verification.json')
    protection = read_json('preservation-after.json')
    take = Path(media['take'])
    audit = json.loads((take / 'verification.json').read_text())
    assert audit['passed'] and playback['passed'] and protection['passed']
    assert not audit['errors'] and not audit['violations']
    assert Path(media['video']).stat().st_size == media['bytes']
    assert hashlib.file_digest(Path(media['video']).open('rb'), 'sha256').hexdigest() == media['sha256']
    assert (OUTPUT / 'full-decode.log').stat().st_size == 0
    assert len(playback['frames']) == len(media['scenes']) * 2
    assert not git('diff', '--name-only', 'HEAD', '--', 'engine', 'apps/studio')
    immutable = git('ls-tree', '-r', '--name-only', 'HEAD', 'demo_app/tests', 'demo_app/AGENTS.md').decode().splitlines()
    assert all((REPO / name).read_bytes() == git('show', f'HEAD:{name}') for name in immutable)
    recipes = REPO / 'tests/fixtures/scripted_agent/wildfire'
    failed_test = json.loads((recipes / 'security_check.json').read_text())['files']['demo_app/tests/test_wildfire_security.py']
    fixed_test = json.loads((recipes / 'harden_input.json').read_text())['files']['demo_app/tests/test_wildfire_security.py']
    assert failed_test == fixed_test
    generations = audit['generations']
    failed = generations['Reject invalid input']
    unsafe = generations['Input experiment']
    hardened = generations['Hardened input']
    assert failed['timeline_id'] is None and failed['status'] == 'failed'
    assert hardened['parent_id'] == unsafe['timeline_id'] == failed['parent_id']
    assert audit['milestones'][-1]['active'] == audit['original']
    paragraphs = [
        '# Primary wildfire demo — final verification report',
        '',
        '## Deliverables and media verification',
        f"- Final MP4: `{media['video']}`.",
        f"- Duration: **{playback['duration']:.2f} seconds**; 1600×900; H.264 High / yuv420p; 25 fps; **zero audio streams**.",
        f"- Size: **{media['bytes']:,} bytes** ({media['bytes'] / 1048576:.2f} MiB). SHA-256: `{media['sha256']}`.",
        '- Entire final video decoded by FFmpeg with exit code 0 and an empty error log. Chrome loaded and played it successfully with no media error.',
        f"- Browser verification extracted {len(playback['frames'])} representative frames across all {len(media['scenes'])} scenes. Actual scene frames are in `review-frames/`; visual review is recorded separately in `VISUAL-REVIEW.md`.",
        '- Timed human narration: `NARRATION-SCRIPT.md`. Executed scenes/prompts/IDs/click coordinates/recovery: `RECORDING-SCRIPT.md`. Both follow the exported edit; the MP4 itself is silent.',
        '- The approximately 3:43 full walkthrough deliberately keeps evidence dwell, following the latest request not to rush. It exceeds the initial approximate 2–3 minute target and the public three-minute pitch description; do not call it a compliant three-minute cut.',
        '',
        '## Exact source and isolation',
        f"- Base revision: `{audit['revision']}`; branch `demo/nasa-wildfire-primary`. Worktree: `{REPO}`.",
        '- Workload/recording adaptations remain uncommitted; this is not a new invented source revision. `source-manifest.json`, `SOURCE-PATCH.diff`, and `workload-and-recorder.zip` identify and preserve the exact additions/changes.',
        '- No engine or Studio product source changed. Existing application tests and AGENTS.md compare byte-for-byte with the base. Feed routes, SQLite schema, parameterized writes, health and smoke behavior remain intact.',
        '- Only new isolated loopback services and disposable state were used. No paid provider, cloud provisioning, public deployment, push, merge, release, or protected recording environment was used for implementation.',
        f"- Authoritative final take: `{take}`. Its verification.json contains real records, validation, patches, logs, model outputs, active-state milestones and recorded mutations. No browser errors or forbidden-origin/provider violations occurred.",
        '',
        '## Dataset and measured model results',
        '- Genuine frozen NASA FIRMS VIIRS export: 1,198 rows / 98,719 bytes. Retrieved 2026-10-25 07:18:21 UTC; observations 2026-10-24 06:50–21:38 UTC.',
        '- SHA-256: `66a3b9ea2f099b04d795292450a84710f57a17e0a23bfafc57b22e9ae82cd9c6`. Fixed timestamp-group split: 1,129 train / 69 held-out rows. Complete attribution/schema/units/filtering/limitations: `DATASET.md`.',
        '- Target: contemporaneous fire radiative power in MW from same-time brightness temperature in K, not wildfire spread, evacuation, or emergency deployment. The holdout is used for selection, not an untouched final generalization assessment.',
        '',
        '| Actual model | MAE MW | RMSE MW | R² | Train ms | Batch inference ms |',
        '| --- | ---: | ---: | ---: | ---: | ---: |',
    ]
    for report in audit['evaluations'].values():
        metrics = report['metrics']
        paragraphs.append(f"| {report['model']['label']} | {metrics['mae']:.6f} | {metrics['rmse']:.6f} | {metrics['r2']:.6f} | {metrics['train_ms']:.6f} | {metrics['inference_ms']:.6f} |")
    paragraphs.extend([
        '',
        'Original is a training mean; A genuine OLS; B training-scaled polynomial ridge. A slightly worsens MAE against Original while improving RMSE. B has lower errors on this small selection set only. No fabricated winner or timing is used; process timings vary.',
        '',
        '## Genuine generations and security ancestry',
        '',
        '| Future/attempt | Generation | Parent timeline | Adopted timeline | Result | Tests |',
        '| --- | --- | --- | --- | --- | --- |',
    ])
    for name, record in generations.items():
        tests = record['evaluation']['tests']
        paragraphs.append(f"| {name} | `{record['id']}` | `{record['parent_id']}` | `{record['timeline_id']}` | {record['status']} | {tests['passed']} passed / {tests['failed']} failed |")
    paragraphs.extend([
        '',
        '- All shown generations use Scripted with actual patches, not a simulated Factory response. Successful candidates pass all six engine checks.',
        '- Unsafe and hardened predictions run only fixed-size arithmetic. The failing test genuinely observes 200 instead of required 422; its attempt is retained but never adopted. The hardened future is a real child of the unsafe timeline, not of the failed attempt.',
        f"- Failed and hardened recipes add byte-identical security tests, SHA-256 `{hashlib.sha256(failed_test.encode()).hexdigest()}`. Hardened activation demonstrates invalid 422 and legitimate 200. This is a scoped local input-validation regression, not penetration testing or general security assurance.",
        f"- Original `{audit['original']}` restored from saved snapshot `{audit['restoreSnapshot']}`. Exact posts equality proves saved SQLite state restoration; restored model ID is original. Five successful timelines remain; the failed attempt has no timeline.",
        '',
        '## Tests executed and non-green regressions',
        '- Original app: 20 passed. Actual engine: A/B 21 passed each; unsafe 22 passed; failed security attempt 23 passed / 1 deliberately failed; hardened 24 passed.',
        '- Studio: typecheck passed; 90 tests across 12 files passed; production build passed. Lint: zero errors, 36 existing warnings. Build also reports the existing large-chunk advisory.',
        '- Broad backend run: **476 passed / 8 failed / 6 skipped**, 655.31 seconds. This run is NOT presented as fully green. Full output: `backend-regression.log`.',
        '- One stale HTML compatibility failure was repaired with an actually used request helper. Fresh targeted rerun: **35 passed / 1 failed** across app tests, demo API tests and the isolated trust assertion; `targeted-regression.log`.',
        '- Five failures are fixed historical test-count assertions: three default-recipe tests expect 19 instead of the actual 21; legitimate popular-feed hardening expects 19 instead of 21; collection-tampering expects 1 collected survivor instead of 3 after two new workload tests. The tampering still fails closed before its obsolete count assertion. No trust or validation control was relaxed.',
        '- One old HTML-restoration fixture replaces the literal old title `The Feed` with `The Future Feed`; the new workload intentionally no longer contains that title. Actual source/model and SQLite restoration pass in the final engine/UI take.',
        '- The configured-trust caplog assertion also fails independently on an untouched `6ecd978` source archive in the same local interpreter (`baseline-trust-test.log`). It is a baseline/environment failure, not claimed fixed. No core changes or test weakening were made.',
        '- Existing immutable tests remain untouched. These six adaptation-specific fixture incompatibilities and the baseline failure are disclosed, not erased or reported as passing. `git diff --check`, Python compile and recorder JavaScript syntax checks passed.',
        '',
        '## Protected assets and fallback',
        f"- SHA-256 recheck: **{protection['files_checked']} existing files**, no missing or modified files across all four protected recording environments; `preservation-before.json` / `preservation-after.json`.",
        '- The latest backup and its Downloads copy both retain SHA-256 `49d04a61f3c5f9d4d8f741c74a86b60e88caf36d933b3e939bbaf75e705bcd6f`; `downloads-backup-before.sha256` / `downloads-backup-after.txt`.',
        '- Original checkout, approved redesign worktree and portable application were not edited. Existing backups remain the fallback; this primary output is in a separate Movies directory.',
        '',
        '## Sponsor evidence and omissions',
        '- Microsoft: real developer-workflow/usefulness evidence, not Microsoft platform integration.',
        '- SpaceXSI: actual NASA data plus actual Cursor composer-2.5 UI implementation task evidence.',
        '- Factory: implemented SDK adapter and clearly identified repository-documented historical success; no recovered raw historical artifacts and no fresh paid or wildfire Factory run.',
        '- Armadin: real limited input-validation failure/remediation; Figma: approved design-to-working-Studio evidence.',
        '- Atlassian: no real Forge app; omitted as a qualifying integration. No Grok Bot, institutional endorsement, unrestricted framework support, native Tauri execution, or production emergency prediction is claimed.',
        '- Sponsor eligibility is not certified. Detailed requirements/evidence/missing items: `SPONSOR-EVIDENCE.md`; pitches and current/future distinction: `SUBMISSION.md`.',
        '',
        '## Artifact index',
        '- Final video; NARRATION-SCRIPT.md; RECORDING-SCRIPT.md; captions.srt.',
        '- media-verification.json; media-probe.txt; full-decode.log; playback-verification.json; review-frames/; VISUAL-REVIEW.md.',
        '- Final take verification.json, shots/, engine/studio logs, disposable engine state and raw WebM.',
        '- DATASET.md; SPONSOR-EVIDENCE.md; SUBMISSION.md; source-manifest.json; SOURCE-PATCH.diff; workload-and-recorder.zip.',
        '- Regression/build/typecheck/lint logs and preservation reports remain in this artifact root.',
        '',
    ])
    report = '\n'.join(paragraphs)
    (OUTPUT / 'VERIFICATION-REPORT.md').write_text(report)
    (REPO / 'docs/wildfire/VERIFICATION-REPORT.md').write_text(report)
    for name in ('DATASET.md', 'SPONSOR-EVIDENCE.md', 'SUBMISSION.md', 'VISUAL-REVIEW.md'):
        shutil.copy2(REPO / 'docs/wildfire' / name, OUTPUT / name)
    names = set(git('diff', '--name-only', 'HEAD').decode().splitlines())
    names.update(git('ls-files', '--others', '--exclude-standard').decode().splitlines())
    prefixes = ('demo_app/', 'scripts/primary_demo/', 'tests/fixtures/scripted_agent/wildfire/', 'docs/wildfire/')
    files = {name: hashlib.sha256((REPO / name).read_bytes()).hexdigest() for name in sorted(names) if name.startswith(prefixes)}
    manifest = {'base_revision': audit['revision'], 'branch': 'demo/nasa-wildfire-primary', 'uncommitted': True, 'sha256': files, 'unchanged_immutable_paths': immutable, 'core_engine_and_studio_unchanged': True}
    (OUTPUT / 'source-manifest.json').write_text(json.dumps(manifest, indent=2))
    (OUTPUT / 'SOURCE-PATCH.diff').write_bytes(git('diff', '--binary', 'HEAD', '--', 'demo_app', 'scripts/primary_demo', 'tests/fixtures/scripted_agent/wildfire', 'docs/wildfire'))
    with zipfile.ZipFile(OUTPUT / 'workload-and-recorder.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name in files:
            archive.write(REPO / name, name)
        archive.write(OUTPUT / 'source-manifest.json', 'source-manifest.json')
        archive.write(OUTPUT / 'SOURCE-PATCH.diff', 'SOURCE-PATCH.diff')
    print(json.dumps({'report': str(OUTPUT / 'VERIFICATION-REPORT.md'), 'source_files': len(files), 'media_sha256': media['sha256']}, indent=2))


if __name__ == '__main__':
    package()
