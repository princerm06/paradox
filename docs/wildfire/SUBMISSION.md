# Paradox — submission material

## General product pitch

One working application. Many possible futures.

Paradox is a software time machine for developers. It turns alternative
implementations into inspectable, executable experiments: generate a future,
review its source changes and validation, compare evidence, deliberately activate
the implementation you choose, and restore a known-good snapshot when needed.
An assistant can write a change; Paradox manages what happens to that change.

The vision extends to APIs, algorithms, ML pipelines, and data systems.
The current demonstration verifies a bounded Python/FastAPI application workflow,
not universal framework compatibility.

## NASA case-study pitch

Wildfire Intelligence Lab is one workload inside Paradox, not Paradox's product
scope. A frozen NASA FIRMS snapshot contains 1,198 satellite-derived thermal
observations. Original uses a mean reference; two real code futures implement
ordinary least squares and polynomial ridge regression on the same training
data and timestamp-group holdout. The target is contemporaneous fire radiative
power, not future spread, evacuation needs, or emergency-resource allocation.

Original MAE/RMSE are 8.356204/24.366925 MW; linear 8.395625/22.254659 MW;
ridge 7.986002/21.725393 MW. The linear model's MAE tradeoff is not hidden.
Selection uses this small holdout, so it is not an untouched final assessment
of generalization or evidence of operational forecasting accuracy.

## Technical depth

React/TypeScript, Vite, and React Flow power the actual redesigned Studio.
Python/FastAPI and SQLite manage the supported application and persisted state.
The workload uses HTML/CSS/JavaScript, SQL/SQLite, deterministic OLS/ridge code,
and measured MAE, RMSE, R², training duration and batch-inference duration.

Real Scripted generation produces patches in isolated candidate workspaces.
The existing engine independently checks boundaries, compilation, tests, boot,
health, and API smoke behavior. Diffs, test results, logs and actual generation
records remain attached to the experiment. Analyze compares existing evidence;
custom ML metrics are shown in actual workload output and generation logs,
not invented Analyze telemetry. Architect shows documented system relationships
and source evidence, not automatic discovery of the wildfire application's topology.

Explicit activation changes the real running implementation. Restoration brings
back saved source and SQLite notebook state while retaining experimental history.
A deliberately bounded input-policy defect demonstrates why functional success
is not equivalent to a passing security requirement: the additional test genuinely
fails, is not adopted, and passes in a real hardened child of the unsafe future.

## Sponsor descriptions

- Microsoft: Help development teams choose changes using measured behavior,
  validation and reversible adoption; no Microsoft service integration claimed.
- SpaceXSI: Experiment with satellite-derived NASA observations without replacing
  the working application. Actual Cursor-assisted UI implementation is documented;
  no Grok Bot or institutional endorsement claimed.
- Factory: The Droid SDK adapter is implemented. Prior successful execution is
  repository-documented. This reproducible wildfire video explicitly uses Scripted;
  generation is only the start of Paradox's inspection/validation/restoration lifecycle.
- Armadin: Investigate a controlled local input-validation defect, preserve the
  actual failed check, and validate a hardened descendant before adoption. This is
  not a penetration test or exhaustive vulnerability assessment.
- Atlassian: Human review is conceptually aligned, but no real Forge integration
  is implemented or claimed; omit a qualifying Forge submission on current evidence.
- Figma: The approved design was integrated into the functioning Studio rather
  than shown as a disconnected prototype. Historical design evidence is supplementary.

## Current versus future

Current verified behavior: this supported application boundary, real deterministic
model/security patches, measured output, existing timeline generation and evidence,
explicit activation, and restoration of source plus state. Implemented but not
invoked in this video: Factory SDK adapter. Historical evidence is identified as such.

Future potential: additional compatible application stacks and experiments.
No unimplemented framework, sponsor integration, production deployment, or
security guarantee is presented as complete. Source-hosting submission requirements
are separate from product functionality; no source-control product screens belong
in the recording.

## Filming and live presentation

The final MP4 is silent. Use the separate `NARRATION-SCRIPT.md` synchronized
to the exported full-length walkthrough. It deliberately preserves feature dwell
instead of copying the short backup's pacing. The public event mentions a
three-minute pitch; use a separately timed live pitch if that cap is enforced,
and do not claim the longer walkthrough is within three minutes.
