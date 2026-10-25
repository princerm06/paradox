# Factory Droid Run 3: recovered execution evidence

This is a historical **Factory Droid SDK run**, recovered as a pre-sanitized
export and reviewed for publication on October 25, 2026. No new Factory run was
made to prepare this package. This folder contains evidence and an offline
verification helper only; it does not change the submitted application.

**The recorded NASA wildfire workflow uses the deterministic Scripted provider,
not Droid. Do not attribute the NASA futures to Factory.** This separate run
changed the original feed demo's ranking behavior.

## Identifiers and verified results

- Generation: `1c98d768-d602-4e6b-b68c-99203bc505ea`.
- SDK session: `9314e994-adfb-4f2e-8ee3-2a02a8026228`.
- Child timeline: `e707847b-6d1b-4b86-a11a-582c59c72d6c`.
- Recorded execution: October 24, 2026, 08:52:45–08:53:15 UTC.
- Prompt: “Rank the feed by popularity, most liked first. Add a test.”
- Provider `droid`; SDK version recorded as `0.10.0`; session model
  `claude-sonnet-4-6`; `direct_only`, autonomy off.
- Session tool calls: five Read, two LS, one Edit, one Create. The engine's agent
  log records two permission-handler approvals, one for each write.
- Generated changes: popularity ranking in `demo_app/ranking.py` (+2/−2) and
  `demo_app/tests/test_popular_ranking.py` (+75 lines, **eight** added tests).
- Saved JUnit report: **26 tests, zero failures/errors/skips** (18 baseline + 8
  added). The validation log independently records `26 passed`.
- Saved engine evaluation and validation log: **six passed checks** — agent,
  guard, compile, tests, boot, smoke. Boot is recorded as 295 ms; smoke records
  HTTP 200 for `/health` and `/api/posts`.
- Saved HTTP evidence links the generated timeline to this generation, records
  subsequent activation, and records parent/child feed isolation and restoration.

## Inspect the primary artifacts

- [SDK session](artifacts/sdk-session.jsonl): sanitized, non-reconstructed
  session records including the actual Edit/Create arguments and tool results.
- [Agent execution log](artifacts/agent.log): session ID, configuration, tool
  events, permission decisions, completion and recorded usage; unchanged bytes.
- [Generated patch](artifacts/generated.patch): genuine recovered diff,
  unchanged bytes; not a patch applied to this repository's application.
- [Validation log](artifacts/validation.log) and [JUnit results](artifacts/tests.xml).
- [Saved HTTP evidence](artifacts/http-evidence.json): generation lifecycle,
  evaluation, timeline linkage, source hashes, and feed observations.
- [Baseline](baseline/demo_app): recovered pre-generation source/test files
  needed to replay the patch offline; unchanged bytes. Agent instructions and
  prompt suggestions are omitted here, not changed in the historical run.
- [Public manifest](manifest.json), [checksums](SHA256SUMS),
  [redaction record](REDACTIONS.md), and [review findings](FINDINGS.md).

## Scope of verification and provenance limits

These conclusions come from mutually consistent recovered execution artifacts,
not just a README or the model's final summary. The session's Edit/Create inputs
match the patch, and applying the patch to the recovered baseline reproduces the
saved generated source hashes. All 12 recovered baseline files also match
repository commit `719ec66f619d8762f53b1a810958cbca612446bf` byte-for-byte; this
package includes the 10 needed for offline replay.

The supplied ZIP was **already sanitized**, not an untouched SDK operational
directory. Its original export manifest's 160 shared-file hashes were checked
against the recovered files; all match. Four additional files are export metadata.
The pre-export originals and provider-side attestations were not supplied, so
their hashes, historical environment, billing and server-side execution cannot
be independently authenticated here. Session IDs and checksums support artifact
correlation/integrity; they are not cryptographic proof of provider origin.

The saved records support genuine SDK execution; they do not prove a fresh run
today, guaranteed contest eligibility, or that the NASA demo used Droid. Recorded
42,278 Factory credits and token counts are SDK-reported usage, not independently
verified billing. `verified: true` is a historical harness result, not a claim
that publication reran all six engine checks.

## Verify without Factory or credentials

From the repository root, with Python 3.9+ and Git available:

```sh
python3 docs/evidence/factory-run-3/verify.py
```

This checks every public checksum, JUnit counts, lifecycle/identifier consistency,
six saved validation outcomes, tool/permission counts, patch/tool-write equality,
and reconstructed source hashes. It applies the patch only inside a disposable
temporary directory, never to the submitted app. It makes no network requests,
starts no engine or SDK session, and requires no Factory account.

To additionally rerun the recovered demo tests with an existing environment that
has pytest, FastAPI and httpx installed:

```sh
python3 docs/evidence/factory-run-3/verify.py --test
```

If dependencies are unavailable, create a separate virtual environment and install
the repository's `requirements-demo.txt`, then use that Python. Those dependency
ranges are not a historical environment lock; a modern replay is distinct from
the archived test run. The helper disables pytest plugin autoload and repository
pytest configuration, matching the original test isolation. Do **not** run
`engine/droid_adapter/verify_live.py` for this review: that starts a paid generation.

The publication review also ran the offline replay successfully: **26 passed**.
This is a new local test replay, not fabricated historical execution output.

## Repository cross-reference

Documentation commit `70c9aa6ce959ccb2745d680ba43097ec8b83650b`,
[`docs/m3/factory-sponsor.md`](../../m3/factory-sponsor.md), documented this run
before recovery. Its “7 tests” detail is a documentation error; primary source,
session and JUnit show **eight** added tests. See FINDINGS.md for other limits.

At the publication base commit, [`engine/droid_adapter/package.json`](../../../engine/droid_adapter/package.json)
pins `@factory/droid-sdk` to `0.10.0`.
[`src/adapter.ts`](../../../engine/droid_adapter/src/adapter.ts) imports the official
`@factory/droid-sdk/node`, calls `listModels`, `createSession`, `updateSettings`,
`listTools`, `stream`, and `close`, and supplies a permission handler and abort
signal. [`engine/providers.py`](../../../engine/providers.py) launches that adapter
inside the write sandbox. [`verify_live.py`](../../../engine/droid_adapter/verify_live.py)
explains the saved HTTP evidence's test/activation/restoration sequence; it was
inspected, not executed for publication.

NASA provider attribution was cross-checked against `docs/wildfire/SUBMISSION.md`
and `docs/wildfire/SPONSOR-EVIDENCE.md` at the separate submission commit
`e53038d68b79fd69beaf3dc15dd943f7ba68d804`. That branch remains unchanged.
