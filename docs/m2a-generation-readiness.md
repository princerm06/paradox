# M2-A repository-aware generation readiness

## Baseline and implementation gate

M1 is integration-ready at backend `7c79aa6`. This separate branch is
`feat/repository-generation-m2a`, rebased onto Codex 2's complete `f4fa14e`
baseline, including its credential-boundary fixes and tests.

Claude published the frozen contract at `c639ba2`, with additive credential gate
`69a8123` and isolated-validation clarification `ffca84a`. This branch inherits
the reviewed runtime profile plumbing from Codex 2's `f4fa14e`. No external runtime
has been started: imported execution remains gated on the credential fix merging
and Claude reviewing Codex 2's execution sandbox. No Factory key is used.

## Ownership coordination

The frozen contract resolves ownership as follows:

- Codex 1: `generations.py` worker `run()`, `validation.py` guard/test-report and
  validation orchestration, `providers.py`, disposable project builder, scripted
  project recipes, and generation tests.
- Codex 2: adapter/preflight/execution sandbox implementation, project workspace
  and state lifecycle, runtime/storage/service integration, trust/import/router,
  and generation constructor/adoption integration.
- Claude: immutable adapter interface and shared contract, desktop wiring and
  cross-component acceptance.

No shared method or file is changed until its owner agrees. In particular,
`generations.py` is split by methods, not independently rewritten by both agents.
  The draft's former adapter/sandbox ownership has been superseded by the frozen
lane interfaces: Codex 2 owns those implementations.

## Proposed generation sequence, subject to freeze

1. Project lifecycle authorizes the repository/configuration trust and creates
   an imported project engine from a pinned committed revision. Import never uses
   checkout, filters, hooks or source working-tree writes. Dirty working edits
   are not silently substituted for that revision.
2. The worker captures its actual parent checkpoint under the engine gate.
   Inactive parents use saved snapshots, never another active workspace.
3. A private generation workspace receives code/state copies from that snapshot.
   The provider is explicitly scripted; no environment default can select Droid
   for an imported project.
4. Recipe selection requires adapter match and required base paths. Project
   recipes are not visible to the bundled demo's legacy recipe selection.
5. Existing guard, compile, baseline collection, tests, boot and smoke stages
   run using the frozen profile and sandbox boundary. Existing tests/manifests
   cannot be weakened. Agent-supplied bytecode is rejected. Runtime validation
   uses disposable state rather than mutating a parent's saved database.
6. Adoption occurs only after validation and cancellation/trust checks. Preserve
   the outgoing live state when activation is requested, then atomically publish
   the new timeline association and successful generation record.
7. Failures retain logs/diffs/evaluation and no adoptable timeline. Cancellation
   stops the subprocess group and cannot subsequently publish a child. Restart
   recovery records interrupted work without running imported applications.

No new endpoint, status or profile field is defined by this sequence. Public
schema and runtime readiness semantics belong to the frozen contract.

## Deterministic adversarial matrix

All future executable cases must select `provider: scripted`, unset
`FACTORY_API_KEY`, use disposable standalone Git repositories, and keep engine
state outside imported roots. No project imports occur during preparation.

| Case | Required observation |
| --- | --- |
| Demo-only profile refactor | Existing demo tests, recipes, errors and provider behavior unchanged |
| Supported notes repository | One committed FastAPI package, health endpoint, SQLite env state, at least three immutable tests |
| Successful feature | Actual source bytes and new test differ; diff/log/checks/timeline association available |
| Compile failure | Failed compile record; no timeline published; source repository unchanged |
| Test failure | Failed tests with trustworthy JUnit counts; no adopted child |
| Protected test or dependency edit | Guard fails before executing changed project code |
| No-op recipe | Existing real-code-change guard fails; no fabricated success |
| Slow cancellation | Cancel queued/running/validated work; no later adoption; independent jobs unaffected |
| Parent switch during generation | Child based on captured parent, not the newly active sibling |
| Inactive parent | Uses its durable snapshot and independent SQLite state |
| State/preview interaction | Child writes survive revisit; parent/sibling state remains unchanged |
| Restart during generation/adoption | Interrupted record fails clearly; transition recovery coherent; no automatic imported boot |
| Dirty source tree | Only pinned committed content imported; warning/metadata retain dirty observation |
| Source fingerprint | Working files, index, refs and objects unchanged across lifecycle |
| Trust revoke | Runtime/job cleanup and adoption rejection follow frozen lifecycle contract |
| Sandbox failure | Fail closed; no unsandboxed test/server fallback |
| Hostile import | Outside-state writes, external sockets, shell exec and credential reads denied |
| Local module shadowing | Dependency preflight never imports source code or dotted parents |
| Original revision differs from current M1 analysis | Revalidate imported committed copy before any execution |
| Explicit Droid request | Reject before a job/paid call; no silent provider fallback |

## Validation bootstrap and review gates

Imported compile, collection and tests use `python -I`, import trusted tooling
before appending the private code root, and use pytest's `--import-mode=append`.
They explicitly set `sys.pycache_prefix` from the private tmp path because `-I`
ignores Python environment configuration. Imported pytest additionally uses
`--confcutdir <code>` to avoid ancestor discovery outside the sandbox. Demo argv
is unchanged. Baseline conftest is staged inside the generation run root.

Focused profile/bootstrap tests: 29 passed in 2.47 seconds. Trusted synthetic
shadow probes verify real compilation, actual failing-test results and collection
counts without executing the notes application. They are not sandbox or imported
runtime acceptance evidence. The pre-rebase full run was stopped: it does not
count toward the required rebased full-suite gate.

Sandbox helper review, launcher `-I` integration, credential-fix merge and project
lifecycle integration remain prerequisites for imported execution. Tests execute
in-process with pytest; hostile application code could still forge test reports.
Validation is evidence, not the security boundary; the OS sandbox is that boundary.

Step 1 profile refactoring and deterministic fixture preparation are implemented
for review. Imported execution is still **NO-GO** pending the independent
credential/sandbox gates and the project lifecycle integration. No remote branch
push or PR creation is permitted under the current user constraints.
