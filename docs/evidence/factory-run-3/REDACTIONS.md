# Publication redactions and exclusions

Original received bytes, the archive, all 164 file hashes, and the full inherited
export/redaction manifests are retained privately outside Git. “Original” here
means the supplied pre-sanitized export, not pre-export operational files.
The public manifest contains only publication hashes and safe source-relative
paths; no raw credentials or private machine identity values are included.

## Additional transformations in this publication

- `artifacts/sdk-session.jsonl`: replace the session-start `hostId` with
  `[REDACTED_HOST_ID]`; replace all absolute run workspace prefixes with
  `[WORKSPACE]`; omit three `visibility: llm_only` environment-reminder records
  (tool catalogs, machine environment/Git context, repeated agent guidance and
  task-management reminder); omit three internal reasoning/signature blocks.
  Retain 14 of the original 17 JSONL records. Actual user request, tool calls,
  tool results, final summary and outcome remain; JSON formatting is normalized.
- `artifacts/validation.log`: replace the absolute run-state prefix on the
  generated XML report location with `[RUN_STATE]`.
- `artifacts/http-evidence.json`: make the same run-state path replacement in
  the embedded validation log; replace the ephemeral localhost application URL
  with `[LOCAL_APP_URL]`. Generation results and feed observations are unchanged.
- `artifacts/tests.xml`: replace the personal machine hostname attribute with
  `[REDACTED_HOSTNAME]`. Test names, counts, timings and timestamps are unchanged.
- `artifacts/agent.log`, `artifacts/generated.patch`, and all 10 replay baseline
  files are byte-for-byte copies of received artifacts: no new redactions.

The genuine patch has three blank context lines consisting of a single space,
as required by unified-diff syntax. The folder's `.gitattributes` exempts only
`artifacts/generated.patch` from blank-at-end-of-line warnings. No patch bytes
are stripped or normalized to satisfy whitespace checking; other files retain
normal checks.

Exact per-file replacement counts appear in `manifest.json`. The private
publication manifest records both received and publication hashes for each copy.
No execution entries were invented, reordered or regenerated. Omissions are
privacy/minimization edits, not evidence of events that did not occur.

## Inherited sanitization (reported by the supplied export)

The supplied report records 20 token-prefix matches, 18 local-home-path matches,
and one structured-credential-field match redacted before receipt; zero private
key, bearer, JWT or credential-URL matches. These are pattern counts, not a claim
that 21 real credentials existed. Pre-export values were not supplied and cannot
be recovered or revalidated here. Existing redaction markers remain.

The received report lists 92 excluded pre-export paths: private Factory
operational settings/caches/certificates and non-evidence runtime/database state.
We preserve that report privately rather than publishing operational layout.

## Files deliberately not published from the ZIP

Only six primary execution artifacts and ten replay baseline files are copied
from the ZIP. The other 148 received files are excluded from this package:

- The 419,298-byte SDK diagnostic log: unnecessary operational/telemetry metadata;
  session and agent logs already carry the relevant execution evidence.
- Repeated snapshot, runtime and workspace trees; duplicate diff and empty logs;
  empty collection JSON; behavior-state copies; agent instructions and prompt
  suggestions not required to replay the actual patch.
- The four top-level export metadata files, including inherited private/original
  hash mappings and operational path details. Public equivalents are authored
  separately and clearly identified as publication documentation.

The review screened all 164 recovered files, not just selected copies, for known
credential/token/private-key/JWT patterns, authorization/credential fields,
credential-bearing URLs, emails, home paths and machine hostnames. The only
network URL found in received textual content was an ephemeral localhost URL;
no private repository or authentication URL was identified. Demo authors and
post contents are synthetic fixture data, not personal participant records.
Security screening is best-effort, not a mathematical guarantee for every
unknown secret format. The unreviewed raw ZIP is never published.
