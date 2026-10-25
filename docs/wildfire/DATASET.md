# Frozen NASA FIRMS wildfire demonstration

## Acquisition and reproducibility

This is an actual, unmodified NASA CSV downloaded over certificate-verified TLS
on **2026-10-25**, starting and completing at **07:18:21 UTC**. The runtime and
tests are offline. They never refresh the data or invoke paid/cloud services.

Exact source:
`https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_USA_contiguous_and_Hawaii_24h.csv`

Retrieval command (SOURCE is the exact URL above):

```sh
curl --fail --show-error --silent --proto '=https' --tlsv1.2 "$SOURCE" -o demo_app/data/nasa_viirs.csv
shasum -a 256 demo_app/data/nasa_viirs.csv
```

Frozen file: `demo_app/data/nasa_viirs.csv`, **98,719 bytes**, **1,198 records**,
plus one header. SHA-256:
`66a3b9ea2f099b04d795292450a84710f57a17e0a23bfafc57b22e9ae82cd9c6`.
Machine-readable provenance is in `demo_app/data/provenance.json`. Startup
checks the hash; re-downloading the rolling URL will generally change it.
The frozen acquisition timestamps cover **2026-10-24 06:50–21:38 UTC**, not the
download day. The URL is a rolling 24-hour export, not a complete daily census.

## Units, inclusion, and split

The continuous target is `frp`, fire radiative power in **MW**. The only measured
predictor is same-time `bright_ti4`, VIIRS I4 brightness temperature in **K**.
Latitude/longitude are degrees north/east, used for display and tie ordering,
not as predictors. Acquisition date plus zero-padded HHMM is interpreted as UTC.
The original confidence, scan, track, I5 temperature, satellite and day/night
columns remain in the CSV but are not model inputs. No confidence selection,
geographic clipping, imputation, deduplication, or synthetic rows are applied.
The named regional export itself can include detections outside strict US
administrative boundaries; the demo preserves the retrieved export.

Reject rows with missing/unparseable required fields, nonfinite coordinates,
brightness or FRP, invalid timestamps, coordinates outside latitude ±90 or
longitude ±180, negative FRP, or brightness outside 200–500 K. All **1,198**
retrieved rows survive these checks. No outcomes are clipped or winsorized.

Sort by UTC timestamp, latitude and longitude. Sort the distinct timestamps,
choose index `floor(0.8 * number_of_distinct_timestamps)` as the first test
timestamp, and train strictly before it. Keep at least one timestamp group
in each side. Thus **1,129 training rows / 69 test rows**; 80% refers to timestamp
groups, not row count. All models share exactly this split. Whole timestamp
groups stay together; this is not shuffled or tuned to obtain a winner.

## Models and metrics

Original is the training-target mean. Its `model.py` exports `fit(rows)`,
`predict(fitted, brightness)`, `MODEL_ID`, `MODEL_LABEL`, `MODEL_DESCRIPTION`.
Each model recipe replaces the actual `model.py`, not a metrics configuration.

- Model A fits an intercept and slope using actual unregularized ordinary least
  squares on `bright_ti4`, with a zero slope for constant training brightness.
- Model B engineers `z=(bright_ti4-300)/100`, `z²`, `z³`. Its centers and population
  standard deviations come only from training data, with unit scale for constant
  columns. It centers the training target, solves the ridge normal equations
  with partial-pivot Gaussian elimination, and uses fixed **lambda=10** for the
  three weights, not the intercept. There is no hyperparameter search.

MAE, RMSE (MW), and dimensionless R² use every held-out row. R² can be negative;
for a constant target it is 1 only for perfect prediction and 0 otherwise.
Predictions are not artificially clipped; linear/ridge extrapolation may be
negative. Training and batch inference durations are actual `perf_counter`
measurements in milliseconds, excluding CSV parsing/HTTP, with no timing
threshold in tests. Inference duration covers all 69 test predictions, not a
single request. Errors are deterministic; timings vary per process/machine.
Each lifespan-enabled app fits once locally at startup.

Observed local evaluations (not promises about other exports):

| Model | MAE | RMSE | R² | Train ms | Batch inference ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original | 8.356204 | 24.366925 | -0.099221 | 0.405792 | 0.004792 |
| A | 8.395625 | 22.254659 | 0.083093 | 0.834416 | 0.006334 |
| B | 7.986002 | 21.725393 | 0.126186 | 3.937958 | 0.047458 |

There is no winner guarantee: A has worse MAE than Original on this split.
The lower-RMSE rule chooses between these fixed candidates. Using the holdout
for that choice makes it a model-selection set, not an untouched final test;
the video makes no claim of independently validated generalization performance.
New tests print `WILDFIRE_EVALUATION` JSON via `capsys.disabled()` so the engine's
normal `pytest -q` validation log includes the actual model, dataset/hash/split,
and measured metrics without hooks or test failures.

## Interpretation and limitations

**Contemporaneous FRP estimation only: NOT a fire-spread, evacuation, ignition,
or future-risk forecast.** Brightness temperature and FRP are radiometrically
related quantities derived from the same-time thermal observation. Association
is therefore expected, not evidence of forecasting skill or causal fire behavior.
Temporal holdout avoids training on test rows but does not remove spatial
dependence or repeated observations of a fire. Clouds, overpass times, missing
coverage, mixed pixels, saturation, near-real-time processing and later revisions
limit these data. Thermal detections can be agricultural, industrial, volcanic
or other non-wildfire sources. Coordinates are detection locations, not fire
perimeters, and FRP is neither fire size nor a ground-truth danger assessment.
This small regional frozen snapshot is not an operational safety system.

## Attribution and data policy

Credit: NASA FIRMS, NASA LANCE, and the Suomi NPP VIIRS science/data teams.
NASA Earthdata describes FIRMS as distributing satellite active-fire and thermal
anomaly observations, including downloadable CSVs, without charge. Preserve this
attribution with the frozen data. This is not a claim that every third-party
asset is public domain, nor NASA endorsement of Paradox. No third-party map tiles
or geographic artwork are included in the application.

Primary references checked October 25, 2026:
- https://www.earthdata.nasa.gov/data/tools/firms
- https://modaps.modaps.eosdis.nasa.gov/services/about/products/viirs-land-c2-nrt/vnp14imgtdl_nrt.html
- https://www.earthdata.nasa.gov/data/use-policy

CSV schema: `latitude`/`longitude` (degrees), `bright_ti4`/`bright_ti5`
(brightness temperature, K), `scan`/`track` (pixel dimensions, km), `acq_date`
(UTC date), `acq_time` (UTC HHMM), `satellite` (platform code), `confidence`
(categorical), `version` (processing version), `frp` (MW), and `daynight` (D/N).
Only the four numeric fields and timestamp described above enter preprocessing.

## API and scripted lineage

`GET /api/wildfire` returns `model`, `dataset`, `metrics`, `observations`,
`predictions`, and `security`. Observations contain latitude, longitude, FRP,
I4 brightness, acquired_at and train/test split; predictions contain actual and
predicted values in matching chronological test-row order.
`POST /api/wildfire/predict` accepts `{"brightness":330}` and returns
`{"prediction":number,"model":label}`. Baseline/hardened policies reject
nonfinite or outside 200–500 K input with 422, before fixed-size local inference.
The feed, health, ranking and SQLite state are independent and unchanged.

Recipes live in `tests/fixtures/scripted_agent/wildfire/`; point the scripted
provider's recipe directory there (its scan is not recursive). Exact prompt
strings are `wildfire model a`, `wildfire model b`, `wildfire unsafe input`,
`wildfire security check`, and `wildfire harden input`. The provider matches
case-insensitive substrings; each recipe uses a unique complete match string,
a two-second delay, accurate Scripted summary, and adds a descendant-compatible
`test_wildfire_feature_general` rather than pinning an ancestor model.

Create A and B as siblings of Original. On the selected model create unsafe;
it intentionally accepts finite negative brightness down to -500 K while
retaining bounded local inference and rejecting nonfinite values. `-10` returns
200 there, while 330 remains valid everywhere. From unsafe, security-check adds
the regression requiring 422 for -10: this must genuinely fail validation and
**must not be adopted**. Create harden from unsafe, not the failed child; it
restores 200–500 K and adds the same regression. Neither security recipe edits
the selected model, feed, engine, existing tests or frontend. No subprocesses,
remote calls, expensive payload processing or unbounded iteration occur on input.
