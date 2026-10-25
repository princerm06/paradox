# Gate A ledger: A1–A3 (2026-10-24)

Scope is `apps/studio/` only, uncommitted, on HEAD `10d56898e8a50f72e92285c8a0471d9c9f7f1227`. Raw output: the first round is in `gate-a-evidence/2026-10-24/`, the follow-up round (final) in `gate-a-evidence/2026-10-24/followup/`.

Runtime: all commands run under Node v20.20.2. The lead's first verification found subprocesses picking up Node 19 although the interactive shell reported 20. To reproduce, run `export PATH=/Users/princem/.nvm/versions/node/v20.20.2/bin:$PATH` before any `npm`/`npx` command.

Lead closeout update: independently reverified tsc, 79/79 Vitest, build, lint (36 warnings), and 8/8 isolated E2E. GPT-6 Sol re-review closed all prior blockers. See `GATE-A-LEAD-VERIFICATION.md` and `GATE-A-VISUAL-AUDIT.md`; reference-fidelity, human rehearsal and baseline approval are still pending. No final Gate A approval is claimed.

## Root causes

| Issue | Root cause (original code) |
|---|---|
| A1 P1 | `prefersFreeProvider()` returned `import.meta.env.DEV` unless `VITE_PARADOX_SAFE_PROVIDER` overrode it. `initialProvider` then fell back to the engine default or the first available provider. A production build against an engine defaulting to `droid` therefore preselected droid, and `VITE_PARADOX_SAFE_PROVIDER=0` did the same in dev. Paid confirmation still guarded the POST, but the default was paid. |
| A2 P1 | `PromptComposer` derived `parent` from `selectedId`, or from the selected ghost's `parent_id`. The **From** picker called `selectTimeline`. Graph or inspector selection, and the post-success "follow the ghost to its timeline", therefore silently changed the next generation's parent. |
| A3 P2 | sessionStorage `submission` was written only from the POST response. Reloading before the response left the previous submission's ID stored, so the strip showed that older record, and the running-generation adoption was skipped because a submission existed. With no prior ID, the code adopted the newest running generation, whoever started it. |

## Changes

- `src/lib/providers.ts`: `initialProvider(list)` returns the available non-paid provider (`scripted`) or `""`. `prefersFreeProvider` was removed.
- `src/composer/PromptComposer.tsx`:
  - A1: problem text when no provider is selected, plus a "Choose an agent" placeholder option so the select never displays a paid provider it hasn't selected.
  - A2: `composerParent` session state, the live default, the *live*/*chosen* label, **Use live**, and declined/missing messages.
  - A3: a `pendingSubmit` record written before the POST and cleared on response (kept on network failure). Matching uses identical parent, prompt, provider, activation and name, and excludes IDs known at submit. A lone match is tracked and labelled unconfirmed. Several matches show the "Unconfirmed submission" panel. The newest-running adoption is suppressed while a pending record exists, and its label now says the run may have been started elsewhere.
- `src/state/workspace.tsx`: exposes `generationsLoaded`, so "no match" is never claimed before a list has arrived. Follow-up: `startGeneration` throws when a 2xx body has no generation record.
- `src/styles/modes.css`: styles for the unconfirmed panel.
- `src/test/gateA.test.tsx` (new), `src/test/recovery.test.tsx` (draft reviewed and kept, two new cases), `src/test/engine.test.tsx` (one label regex).
- `e2e/guard.ts`: the firewall's generation check is shared with a new `holdNextGenerationResponse`. That helper applies the same checks, lets the request reach the isolated engine, and withholds the response from the page.
- `e2e/isolated.spec.ts`: 5 new specs. `playwright.config.ts`: the dead `VITE_PARADOX_SAFE_PROVIDER` was dropped from the Vite env.
- `README.md`, `HANDOFF.md`: updated. The shutdown checkpoint is unchanged.

## Follow-up round: review findings (independent read-only review, after the lead's first verification)

| Finding | Defect in the first round | Fix |
|---|---|---|
| 1 P1 | Submit A, switch engine, come back, submit B before A's response. A's late callback used setters bound to the old engine base, so it wrote sessionStorage after unmount: it cleared B's pending record and stored A as the submission. A reload before B's response then showed A. The existing switch test only resolved A while the other engine was shown, so it never had a B. | Each pending record carries a local correlation `token` (random, never sent to the engine, not a generation ID). The success and failure callbacks re-read that engine's stored pending record and only write if the token is still theirs. A late response for a request that is still the stored one resolves it, even if another engine is shown. A response for a replaced or dismissed request writes nothing. Its record stays on the engine and in the graph. |
| 2 P1 | The catch kept the pending record only for `ApiError` status 0. A 5xx, an unreadable body, invalid JSON, or an empty 2xx can all follow an accepted request, and they erased the recovery context. | Only a 4xx other than 408 counts as a definitive rejection and clears the context. Every other failure keeps it, with a `failure` note, and shows "The outcome is unknown: the engine may have started this generation. Nothing was resubmitted." The list is reloaded (GET only), and the panel says "Outcome unknown". The newest-running adoption stays suppressed while the context exists, so another client's run is never adopted. `startGeneration` now rejects a 2xx response without a generation record. |
| 3 P2 | A lone match cleared the pending context in an effect. A second identical record in a later poll was then never shown. | The lone match is derived during render and the context is kept. It is shown as a strip labelled unconfirmed, with **Track this one** (and **Dismiss** when terminal). If a later list adds a second lookalike, the strip becomes the candidate list: one panel, no duplicate strip, and no effect loop, because the effect was removed. The context ends only on **Track this one**, **Dismiss**, a definitive rejection, or the request's own POST response. |

The match wording changed from "Recovered after reload by matching…" to "Recovered without the engine's response, by matching prompt, parent and provider…", because it now also covers same-page lost responses. One E2E assertion and three Vitest regexes were updated to match. A1 and A2 code was not changed in this round.

Mutation checks, one fix reverted at a time:
- Token guard forced to always-own: both stale-A cases fail.
- Old status-0-only rule: the 5xx, malformed, empty and unreadable cases fail, plus the nothing-created 504 case. The network case passes, as the old code already kept status 0.
- Old clearing effect restored: the successive-candidate case and all 5 ambiguous cases fail.

## Draft test review

- The 9 draft cases were kept. Two were test-timing defects, fixed in the tests:
  - `makeRunning` stamped `updated_at` one second in the future, so the fake engine's cancel response looked stale.
  - The ambiguity count was asserted before the list arrived.
- Strip lookups now wait for `.submission` itself, because the unconfirmed panel shares the heading markup.
- Assertions were added that a matched record is labelled unconfirmed. Nothing asserts browser ownership of a matched record.
- Mutation check: with the original `PromptComposer.tsx` and `providers.ts` restored temporarily, 16 of the 19 new and draft cases failed. The 3 that passed cover behaviour the old code already had: cancel after adoption, engine switch, and a delayed response on the same page.

## Real-engine reproduction (A3)

- On the original composer, against an isolated scripted engine, the spec "reload before the generation response…" fails.
  - The engine accepted `slow delayed response` (202, one record).
  - After reload, the strip showed the previous `popular baseline before delay`, labelled "Restored after reload from the engine's record", while the new job ran.
- With the fix, the same spec passes. The strip shows the new record, labelled unconfirmed. Cancel is accepted by the engine (`cancelled`). There is exactly one record for the prompt, all earlier records are preserved, and the firewall saw 2 scripted POSTs.
- Harness bug found and fixed during this work: the hold helper first called `page.unroute` inside its own handler. Playwright then passed the paused request on to the firewall, which continued it, so the engine received it twice. This was a test-helper defect, not Studio or engine behaviour.

## Verification history

1. First round (implementer): tsc 0, Vitest 68/68, build 0, oxlint 36 warnings, E2E 8/8.
2. Lead's independent verification of the first round: the same results (68 Vitest, 8 E2E). This is **pre-follow-up and not final**. Initially it ran under Node 19 subprocesses; it was rerun with the PATH fix above. Lead screenshots are in `/tmp/paradox-gate-a-lead-shots`.
3. Independent read-only review: findings 1–3 above. 1 and 2 block acceptance. It found no duplicate send and no firewall bypass in the hold helper.
4. Follow-up round (implementer, final): the table below. This still needs the lead's re-verification.

## Results (follow-up run, final, from `apps/studio/`, Node v20.20.2)

| Command | Result |
|---|---|
| `npx tsc -b` | exit 0 |
| `npx vitest run` | 7 files, 79/79 passed (68 earlier plus 11 new), green on 2 consecutive full runs. |
| `npm run build` | exit 0 |
| `npx oxlint` | exit 0, 0 errors, 36 warnings. This equals the HEAD baseline, measured on a `git archive HEAD` copy: 11 only-export-components, 14 refs, 11 set-state-in-effect. |
| `npm run e2e` | 8/8 passed: 3 existing specs and 5 from the first round. There are no new E2E specs for the follow-up; see below. Ports :8010 and :5174 had no listeners afterwards. |

## Scenario coverage

| Scenario | Synthetic (Vitest FakeEngine) | Real isolated engine (Playwright) |
|---|---|---|
| A1: production build, engine default droid, scripted available | yes (`DEV=false`, `PROD=true`, old override `0`) | no droid on the isolated engine by design; the default scripted value and POST body were verified |
| A1: scripted unavailable means no provider, explicit choice required | yes | not run (would need a non-scripted provider available) |
| A1: paid confirmation cancelled (button and ⌘↵), no POST | yes | firewall blocks any non-scripted POST |
| A1: refresh and engine switch reset the provider | yes | — |
| A2: inspection and selection of a timeline or ghost leave the parent unchanged; POST parent_id | yes | yes (generated child inspected, reload, POST `parent_id` = live, active unchanged) |
| A2: explicit parent across refresh, engine-scoped, **Use live** | yes | — |
| A2: declined or missing chosen parent blocks submission | yes | — |
| A3: fresh session, immediate reload | yes | not run separately (the real specs all start after earlier records exist) |
| A3: prior completed stored ID | yes | yes |
| A3: completion during reload | yes (failed outcome) | yes (succeeded outcome) |
| A3: cancel after reload | yes | yes |
| A3: identical concurrent submissions | yes (plus an unrelated run excluded) | yes (second POST made via the page, so it passed the firewall) |
| A3: lone lookalike from another client, ours never created | yes (labelled unconfirmed) | — |
| A3: no match, then a late list match via **Check again** | yes | — |
| A3: engine switch during recovery | yes | yes (response delivered while the other engine was shown; recorded for the original engine only) |
| A3: delayed response arriving on the same page | yes | — |
| A3: late A response (success, or 5xx) after switching away, back, and submitting B; reload before B's response | yes (follow-up). B is shown, A is not, A is not stored, both records are kept, 2 POSTs | — |
| A3: late response while the other engine is shown resolves its own request | yes (follow-up, exact confirmed ID) | yes (first round) |
| A3: the engine creates the record, then the POST response is 5xx, malformed JSON, empty 2xx, an unreadable body, or a network failure | yes (follow-up). Outcome unknown, the strip shows the created record labelled unconfirmed and not the other client's running run, Cancel targets it, 1 POST | — |
| A3: 504 with nothing created | yes (follow-up). Outcome unknown, no match, no adoption | — |
| A3: definitive 422 | yes (follow-up). The context is cleared and there is no panel | — |
| A3: a lone guess, then a second identical record on the next 15s list poll | yes (follow-up, fake timers). One panel and no strip, Track this one picks the exact ID, 1 POST | — |
| Request counts and no automatic resubmission | asserted in every case | asserted via the firewall and engine lists |

## Unresolved risks

- A lone attribute match is shown automatically as an unconfirmed guess. It is not stored as the submission until the user picks **Track this one**, and it turns back into a list if a lookalike appears later. A concurrent identical request from another client, with ours never created, is indistinguishable without a backend idempotency key or client request ID, which would be a backend change and is Abhi's call.
- `knownIds` comes from the last list (polled every 15s). Another client's record created just before submit can therefore appear as a candidate. It is labelled, never presumed.
- Submitting again while an unresolved pending record exists replaces it. Earlier records stay on the engine and in the graph. A late response for the replaced request changes nothing in this tab's recovery state.
- The ambiguous-outcome cases are synthetic only. The real-engine path for a held response is the same code, but an isolated E2E for 5xx-after-accept would need a response-rewriting route in the guard. It was not added, to keep the firewall helper minimal.
- If the tab returns to an engine and a late response then resolves that engine's stored request, the visible instance keeps showing the matched guess, labelled unconfirmed, until the next reload, which shows the confirmed record. The visible instance does not subscribe to its own sessionStorage writes. The display is honest, just less specific.
- The 4xx-means-rejected rule assumes the engine validates before creating a record. A 4xx after creation would drop recovery context, but the record still appears in the graph.
- No-match stays visible until the user dismisses it. It never shows as running.
- No browser verification with an actually available paid provider. This is intentional, given the no-paid-runs rule.
- Pre-existing Studio Vite PID 24401 (`--host 127.0.0.1`, ownership unknown) was left alone. All test servers used :8010/:5174 and shut down cleanly with no lease left. `$TMPDIR/paradox-audit-final-*` is not from this work and was left alone.
- Visual audit, human rehearsal and baseline approval remain pending.
