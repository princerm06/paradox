# Demo-ready future prompts

## 1. A better feed, not a different database

> Make this feed popular-first: show posts with more likes before newer posts.
> Replace the implementation in demo_app/ranking.py, label it popular, and break
> ties by created_at descending then id descending. Keep the SQLite schema, post
> API, existing data, and protected tests unchanged. Add a new regression test
> proving that an older post with eight likes beats a newer post with one like.

**Offline provider:** `scripted` matches `popular`. The visible order reverses
immediately on activation, while posts and likes written in the parent remain
available. Like a post in the child, return to the parent, then revisit the child
to demonstrate separate working futures rather than a cosmetic preview.

## 2. Answer “what is happening in this community?”

> Add a read-only GET /api/stats endpoint returning total_posts, total_likes, and
> unique_authors from the current SQLite database. Show those three counts in a
> compact summary at the top of the demo feed and refresh them after publishing
> or liking a post. Keep existing endpoints, ranking behavior, database schema,
> and protected tests unchanged. Use relative API URLs and textContent rather
> than interpolating post data as HTML. Add new tests for the seeded counts,
> creating a post, and liking a post. Do not add dependencies.

**Live provider required:** Droid or Claude when available; there is intentionally
no matching scripted recipe. A visitor can see a genuinely new backend endpoint
and a matching UI, then return to the parent where neither exists. Confirm the
future only after examining its source diff and passing validation.

## 3. Find your signal without changing the source feed

> Add an accessible search box to the demo feed. Filter the displayed
> posts by author or content, case-insensitively, preserve the backend's ranking,
> and show an empty-state message when nothing matches. Clearing the search must
> restore the complete feed. Keep all existing API and SQLite contracts and
> protected tests unchanged. Avoid new dependencies and unsafe HTML insertion.
> Add a pure Python matching helper in demo_app/search.py with regression tests
> covering author/content matches, case-insensitivity, and an empty query; use
> that helper for an additive GET /api/search?q= endpoint returning the filtered
> feed, and have the UI use that endpoint for nonempty queries.

**Live provider required:** no scripted fixture matches this feature. Compare a
quiet, searchable future with the original feed while preserving timeline-local
posts and likes. The additive endpoint makes the feature verifiable beyond UI
markup. Search matches only author/content; it must not change stored rows.

## Rehearsal controls (scripted provider)

- Success: `Make the feed popular-first and add a regression test.`
- Compile rejection: `Break the app to demonstrate compile-time validation.`
- Test rejection: `Add a failing test to demonstrate an unsafe future.`
- Guard rejection: `Delete a test to demonstrate protected-suite enforcement.`
- Background work: `Make a slow harmless change while I keep using the parent.`
  This waits exactly five seconds before applying files; cancel it immediately
  to exercise cancellation, or let it finish to get a passing future.

Use a fresh generation for each phrase. Wait for a terminal status before
activating a successful future. Failures and cancellations must create no
timeline. All scripted rehearsals work without provider credentials. A temporary
workspace is not a security sandbox; use only trusted local prompts and code.
