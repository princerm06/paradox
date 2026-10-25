# Paradox primary demo — executed recording script

Base revision: `6ecd978dec64cc419ea53faadb9f3e0c3abcf6df` plus the isolated workload changes in source-manifest.json.
Final video: `/Users/princem/Movies/paradox-primary-wildfire-20261025.NIusOG/Paradox-NASA-Wildfire-Primary.mp4`

Every scene is from one genuine, continuous workflow. The editor adds captions and click rings only. No application state, measured metric, log, or failure is composited into the UI.

## Exact scenes

### 00:00:00.000–00:00:07.001 — PARADOX — A SOFTWARE TIME MACHINE
One working application. Many possible futures.
Start in Explore with the real populated timeline. Original is live; Model A has already passed genuine generation. Fit the graph. Do not select an import/project workflow.
Scene ID: `01`. Executed controls and assertions: `scripts/primary_demo/run.mjs`. Real click positions/times are listed below.

### 00:00:07.007–00:00:23.008 — TODAY: NASA-DERIVED WILDFIRE OBSERVATIONS
A real offline dataset. An observational model—not a fire-spread forecast.
Open Portal, expand the live Original iframe, read the dataset and MAE/RMSE, then scroll to the two plots. A transient notebook note is added through the actual posts API for the later restoration assertion.
Scene ID: `02`. Executed controls and assertions: `scripts/primary_demo/run.mjs`. Real click positions/times are listed below.

### 00:00:23.021–00:00:37.023 — CREATE A DIFFERENT IMPLEMENTATION
Scripted applies a real code patch. Original stays live.
Return to Explore; set Parent future to Original, use Name to enter `Model B · Ridge`, and fill `wildfire model b`. Keep Agent provider Scripted and Keep live selected; click Generate future and wait for validation. Verify Original remains live.
Scene ID: `03`. Executed controls and assertions: `scripts/primary_demo/run.mjs`. Real click positions/times are listed below.

### 00:00:37.037–00:00:49.038 — REAL CODE. REAL ALTERNATIVES.
Python implementations, independent snapshots, inspectable changes.
Select Model B in Futures; open Inspect → Diff. Display the real `demo_app/model.py` patch.
Scene ID: `04`. Executed controls and assertions: `scripts/primary_demo/run.mjs`. Real click positions/times are listed below.

### 00:00:49.048–00:00:59.048 — VALIDATE BEFORE ADOPTION
Compilation, tests, boot and HTTP checks run in the actual engine.
In Model B Inspect, choose Tests. Show all six checks passed and the actual test total.
Scene ID: `05`. Executed controls and assertions: `scripts/primary_demo/run.mjs`. Real click positions/times are listed below.

### 00:00:59.060–00:01:09.061 — MEASUREMENTS STAY WITH THE FUTURE
MAE and RMSE come from the same frozen held-out observations.
Choose Logs and scroll to `MEASURED MODEL:`. Display the measured error lines and frozen dataset/split evidence, not a substituted screenshot.
Scene ID: `06`. Executed controls and assertions: `scripts/primary_demo/run.mjs`. Real click positions/times are listed below.

### 00:01:09.071–00:01:23.072 — COMPARE FIRST. NOTHING GOES LIVE.
Analyze compares recorded validation, code changes and execution logs.
Open Analyze; choose Model A as Future A and Model B as Future B. Inspect Validation then Diffs. Assert Original is still live; select the preferred candidate by recorded held-out RMSE.
Scene ID: `07`. Executed controls and assertions: `scripts/primary_demo/run.mjs`. Real click positions/times are listed below.

### 00:01:23.084–00:01:35.084 — A SYSTEM BEHIND EVERY EXPERIMENT
React + TypeScript · React Flow · Python + FastAPI · SQLite
Open Architect, Fit map, then zoom and select Timeline engine. Read the actual documented system evidence; do not describe this as automatic workload-topology discovery.
Scene ID: `08`. Executed controls and assertions: `scripts/primary_demo/run.mjs`. Real click positions/times are listed below.

### 00:01:35.093–00:01:43.094 — FACTORY DROID SDK ADAPTER IMPLEMENTED
This wildfire demonstration uses Scripted—not a Factory-generated run.
Select the actual droid component in Architect. Show the SDK adapter evidence with the explicit Scripted-demo caption. Do not start Factory or imply this was a live paid run.
Scene ID: `08B`. Executed controls and assertions: `scripts/primary_demo/run.mjs`. Real click positions/times are listed below.

### 00:01:43.107–00:01:57.109 — RUN THE LINEAR IMPLEMENTATION
Explicit activation loads Model A. Its measured results come from real execution.
Return to Explore; select Model A in Futures → Inspect. Click Make live, then Switch runtime in the confirmation. Open Portal → Expand and show `model_a` and its measured metrics.
Scene ID: `09A`. Executed controls and assertions: `scripts/primary_demo/run.mjs`. Real click positions/times are listed below.

### 00:01:57.122–00:02:11.123 — ACTIVATE ONLY WHEN YOU DECIDE
The preferred implementation becomes the real running application.
Select preferred Model B in Futures → Inspect. Click Make live → Switch runtime. Open its actual live Portal; show `model_b`, changed model name, and its errors.
Scene ID: `09B`. Executed controls and assertions: `scripts/primary_demo/run.mjs`. Real click positions/times are listed below.

### 00:02:11.142–00:02:29.143 — BRANCH AGAIN: A CONTROLLED INPUT DEFECT
An implementation can pass functional tests and still miss an input boundary.
From the preferred Parent future, Generate future with prompt `wildfire unsafe input` and name Input experiment. After success use Make live → Switch runtime. In Portal set Brightness to `-10`, click Check input, scroll to the response, and show actual HTTP 200. This is only bounded local arithmetic.
Scene ID: `10`. Executed controls and assertions: `scripts/primary_demo/run.mjs`. Real click positions/times are listed below.

### 00:02:29.166–00:02:45.166 — THE SECURITY CHECK FAILS — FOR REAL
The failed generation is recorded, not adopted as a runnable future.
From Input experiment Generate `wildfire security check` named Reject invalid input. Wait for actual failure; inspect Logs at the assertion expecting 422. Verify the failed record has null timeline_id and was not adopted.
Scene ID: `11`. Executed controls and assertions: `scripts/primary_demo/run.mjs`. Real click positions/times are listed below.

### 00:02:45.180–00:03:03.180 — FIX THE BOUNDARY. VERIFY THE CHILD.
A hardened child passes the same regression and preserves valid predictions.
Select Input experiment again—not the failed record. Generate `wildfire harden input` named Hardened input. Open Tests and show passing validation, then Diff and the actual identical security regression. Verify its real parent is Input experiment.
Scene ID: `12`. Executed controls and assertions: `scripts/primary_demo/run.mjs`. Real click positions/times are listed below.

### 00:03:03.200–00:03:17.200 — EXPLICIT ADOPTION. VERIFIED REJECTION.
HTTP 422 for invalid input. HTTP 200 for legitimate observations.
Use Make live → Switch runtime on Hardened input. In Portal enter brightness `-10` → Check input, scroll to the response, and hold actual 422 for four seconds. Then enter `330` → Check input and hold actual 200. These are real HTTP responses, not captions standing in for tests.
Scene ID: `13`. Executed controls and assertions: `scripts/primary_demo/run.mjs`. Real click positions/times are listed below.

### 00:03:17.215–00:03:35.215 — RESTORE IMPLEMENTATION AND SAVED STATE
Original returns. The experimental history remains inspectable.
Select Original → Inspect → Snapshots. Restore the saved reference snapshot and confirm Restore and go live. Show Original model and expand the state notebook; saved reference note returns and transient note is absent.
Scene ID: `14`. Executed controls and assertions: `scripts/primary_demo/run.mjs`. Real click positions/times are listed below.

### 00:03:35.225–00:03:43.120 — PARADOX — EXPLORE EVERY FUTURE
For software experiments: APIs, algorithms, data pipelines and beyond.
Close Portal/Inspect, Fit the genuine graph. End with Original live, all five successful timelines retained, and the failed security generation still recorded separately.
Scene ID: `15`. Executed controls and assertions: `scripts/primary_demo/run.mjs`. Real click positions/times are listed below.

## Actual generations and ancestry
Original: `ce95e65d-5f75-4050-9c37-cd45aa49297a`. Saved restoration snapshot: `66945cdb-c12e-4bcd-9746-1369b4f37eb6`.

- **Model A · Linear:** generation `007444dc-6956-4840-86c5-d99f53e6072f`, parent `ce95e65d-5f75-4050-9c37-cd45aa49297a`, timeline `98541f67-f4da-4528-ac20-c0fc4c5b887e`, status `succeeded`; prompt `wildfire model a`; provider `scripted`.
  Tests: `{"passed": 21, "failed": 0, "errors": 0}`. Checks: `[{"name": "agent", "status": "passed", "duration_ms": 2007, "detail": null}, {"name": "guard", "status": "passed", "duration_ms": 6, "detail": null}, {"name": "compile", "status": "passed", "duration_ms": 167, "detail": null}, {"name": "tests", "status": "passed", "duration_ms": 1459, "detail": "21 passed"}, {"name": "boot", "status": "passed", "duration_ms": 249, "detail": null}, {"name": "smoke", "status": "passed", "duration_ms": 14, "detail": "GET /health 200, GET /api/posts 200"}]`.
- **Model B · Ridge:** generation `3568fc76-1b19-4932-954f-e46b84c7deb3`, parent `ce95e65d-5f75-4050-9c37-cd45aa49297a`, timeline `8616d0f9-d822-4457-803c-8352e14de73b`, status `succeeded`; prompt `wildfire model b`; provider `scripted`.
  Tests: `{"passed": 21, "failed": 0, "errors": 0}`. Checks: `[{"name": "agent", "status": "passed", "duration_ms": 2005, "detail": null}, {"name": "guard", "status": "passed", "duration_ms": 2, "detail": null}, {"name": "compile", "status": "passed", "duration_ms": 158, "detail": null}, {"name": "tests", "status": "passed", "duration_ms": 1848, "detail": "21 passed"}, {"name": "boot", "status": "passed", "duration_ms": 288, "detail": null}, {"name": "smoke", "status": "passed", "duration_ms": 16, "detail": "GET /health 200, GET /api/posts 200"}]`.
- **Input experiment:** generation `2d6ef923-abb7-4190-8fc7-77a386b61d5e`, parent `8616d0f9-d822-4457-803c-8352e14de73b`, timeline `59adbbcd-02c8-454a-a23d-a3f83817d1cd`, status `succeeded`; prompt `wildfire unsafe input`; provider `scripted`.
  Tests: `{"passed": 22, "failed": 0, "errors": 0}`. Checks: `[{"name": "agent", "status": "passed", "duration_ms": 2008, "detail": null}, {"name": "guard", "status": "passed", "duration_ms": 2, "detail": null}, {"name": "compile", "status": "passed", "duration_ms": 159, "detail": null}, {"name": "tests", "status": "passed", "duration_ms": 1992, "detail": "22 passed"}, {"name": "boot", "status": "passed", "duration_ms": 290, "detail": null}, {"name": "smoke", "status": "passed", "duration_ms": 16, "detail": "GET /health 200, GET /api/posts 200"}]`.
- **Reject invalid input:** generation `f2dd0ee3-83f3-4819-b6ef-dbbf819bf860`, parent `59adbbcd-02c8-454a-a23d-a3f83817d1cd`, timeline `None`, status `failed`; prompt `wildfire security check`; provider `scripted`.
  Tests: `{"passed": 23, "failed": 1, "errors": 0}`. Checks: `[{"name": "agent", "status": "passed", "duration_ms": 2003, "detail": null}, {"name": "guard", "status": "passed", "duration_ms": 2, "detail": null}, {"name": "compile", "status": "passed", "duration_ms": 159, "detail": null}, {"name": "tests", "status": "failed", "duration_ms": 2210, "detail": "Generated application tests failed; inspect validation logs"}]`.
- **Hardened input:** generation `96ab718e-03c9-416e-8c7c-4f6c66ed04f8`, parent `59adbbcd-02c8-454a-a23d-a3f83817d1cd`, timeline `5da57337-9718-499c-8d86-24659b25a0b1`, status `succeeded`; prompt `wildfire harden input`; provider `scripted`.
  Tests: `{"passed": 24, "failed": 0, "errors": 0}`. Checks: `[{"name": "agent", "status": "passed", "duration_ms": 2008, "detail": null}, {"name": "guard", "status": "passed", "duration_ms": 2, "detail": null}, {"name": "compile", "status": "passed", "duration_ms": 163, "detail": null}, {"name": "tests", "status": "passed", "duration_ms": 2186, "detail": "24 passed"}, {"name": "boot", "status": "passed", "duration_ms": 306, "detail": null}, {"name": "smoke", "status": "passed", "duration_ms": 16, "detail": "GET /health 200, GET /api/posts 200"}]`.

## Real model outputs
```json
{
  "original": {
    "model": {
      "id": "original",
      "label": "Original \u00b7 train mean",
      "description": "Training-only mean FRP; contemporaneous estimation, not a forecast."
    },
    "metrics": {
      "mae": 8.356204413293796,
      "rmse": 24.366924894346056,
      "r2": -0.09922076431142535,
      "train_ms": 0.407750005251728,
      "inference_ms": 0.005083988071419299
    },
    "dataset": {
      "source": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_USA_contiguous_and_Hawaii_24h.csv",
      "label": "NASA FIRMS Suomi NPP VIIRS C2 \u00b7 frozen 24h export",
      "sha256": "66a3b9ea2f099b04d795292450a84710f57a17e0a23bfafc57b22e9ae82cd9c6",
      "rows": 1198,
      "window_start": "2026-10-24T06:50:00+00:00",
      "window_end": "2026-10-24T21:38:00+00:00",
      "train_rows": 1129,
      "test_rows": 69,
      "split": "First floor(80% of distinct UTC timestamps) train; remaining timestamps test; no timestamp overlaps.",
      "units": {
        "frp": "MW",
        "bright_ti4": "K",
        "latitude": "degrees north",
        "longitude": "degrees east",
        "acquired_at": "UTC"
      },
      "limitation": "Same-time brightness and FRP are radiometrically related. This estimates contemporaneous FRP, NOT fire spread, evacuation, or future fire risk. Satellite detections include non-wildfire thermal anomalies; coverage, clouds and saturation limit interpretation."
    }
  },
  "model_a": {
    "model": {
      "description": "Ordinary least squares FRP from same-time VIIRS I4 brightness; not a forecast.",
      "id": "model_a",
      "label": "Model A \u00b7 brightness OLS"
    },
    "metrics": {
      "inference_ms": 0.006415997631847858,
      "mae": 8.395624600621305,
      "r2": 0.08309288037453566,
      "rmse": 22.25465854998659,
      "train_ms": 0.8542919968022034
    },
    "dataset": {
      "label": "NASA FIRMS Suomi NPP VIIRS C2 \u00b7 frozen 24h export",
      "limitation": "Same-time brightness and FRP are radiometrically related. This estimates contemporaneous FRP, NOT fire spread, evacuation, or future fire risk. Satellite detections include non-wildfire thermal anomalies; coverage, clouds and saturation limit interpretation.",
      "rows": 1198,
      "sha256": "66a3b9ea2f099b04d795292450a84710f57a17e0a23bfafc57b22e9ae82cd9c6",
      "source": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_USA_contiguous_and_Hawaii_24h.csv",
      "split": "First floor(80% of distinct UTC timestamps) train; remaining timestamps test; no timestamp overlaps.",
      "test_rows": 69,
      "train_rows": 1129,
      "units": {
        "acquired_at": "UTC",
        "bright_ti4": "K",
        "frp": "MW",
        "latitude": "degrees north",
        "longitude": "degrees east"
      },
      "window_end": "2026-10-24T21:38:00+00:00",
      "window_start": "2026-10-24T06:50:00+00:00"
    }
  },
  "model_b": {
    "model": {
      "description": "Fixed-lambda ridge with training-only scaling of same-time I4 polynomial features; not a forecast.",
      "id": "model_b",
      "label": "Model B \u00b7 engineered ridge"
    },
    "metrics": {
      "inference_ms": 0.050874994485639036,
      "mae": 7.986002065721963,
      "r2": 0.1261864864946044,
      "rmse": 21.72539299638727,
      "train_ms": 4.343207998317666
    },
    "dataset": {
      "label": "NASA FIRMS Suomi NPP VIIRS C2 \u00b7 frozen 24h export",
      "limitation": "Same-time brightness and FRP are radiometrically related. This estimates contemporaneous FRP, NOT fire spread, evacuation, or future fire risk. Satellite detections include non-wildfire thermal anomalies; coverage, clouds and saturation limit interpretation.",
      "rows": 1198,
      "sha256": "66a3b9ea2f099b04d795292450a84710f57a17e0a23bfafc57b22e9ae82cd9c6",
      "source": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_USA_contiguous_and_Hawaii_24h.csv",
      "split": "First floor(80% of distinct UTC timestamps) train; remaining timestamps test; no timestamp overlaps.",
      "test_rows": 69,
      "train_rows": 1129,
      "units": {
        "acquired_at": "UTC",
        "bright_ti4": "K",
        "frp": "MW",
        "latitude": "degrees north",
        "longitude": "degrees east"
      },
      "window_end": "2026-10-24T21:38:00+00:00",
      "window_start": "2026-10-24T06:50:00+00:00"
    }
  }
}
```

## Click indicators
Each red ring appears at an actual clicked control for 0.44 seconds, fades, and disappears. Coordinates are CSS pixels of the 1600×800 application frame; the caption panel adds 100 pixels below, not over the app.
```json
[
  {
    "second": 24.236818375,
    "label": "Generate future\n\u2318\u21b5",
    "x": 1500.03125,
    "y": 698.609375,
    "width": 143.9375,
    "height": 48
  },
  {
    "second": 37.374366917,
    "label": "Model B \u00b7 Ridge\nPending",
    "x": 222,
    "y": 364.078125,
    "width": 246,
    "height": 44
  },
  {
    "second": 37.93256362499999,
    "label": "Diff",
    "x": 1161.8984375,
    "y": 215.84375,
    "width": 114.609375,
    "height": 33.9375
  },
  {
    "second": 49.3139575,
    "label": "Tests",
    "x": 1399.1015625,
    "y": 215.84375,
    "width": 114.609375,
    "height": 33.9375
  },
  {
    "second": 59.323188542000004,
    "label": "Logs",
    "x": 1280.5,
    "y": 215.84375,
    "width": 114.59375,
    "height": 33.9375
  },
  {
    "second": 69.336312667,
    "label": "Analyze",
    "x": 482.1015625,
    "y": 31.5,
    "width": 103.578125,
    "height": 38.84375
  },
  {
    "second": 69.88253666700001,
    "label": "Validation",
    "x": 172,
    "y": 408.734375,
    "width": 96,
    "height": 40.84375
  },
  {
    "second": 73.425586708,
    "label": "Diffs",
    "x": 372,
    "y": 408.734375,
    "width": 96,
    "height": 40.84375
  },
  {
    "second": 83.34842641700001,
    "label": "Architect",
    "x": 369.734375,
    "y": 31.5,
    "width": 111.15625,
    "height": 38.84375
  },
  {
    "second": 87.288181375,
    "label": "SERVICE\nTimeline engine\nParadox Timeline Engine 0.1.0\nOBSERVED",
    "x": 428.5736389160156,
    "y": 765.6465759277344,
    "width": 192.26190185546875,
    "height": 129.76092529296875
  },
  {
    "second": 95.357132292,
    "label": "PROVIDER\ndroid\nunavailable\nOBSERVED",
    "x": 598.5736389160156,
    "y": 1063.2179870605469,
    "width": 125.47613525390625,
    "height": 115.59429931640625
  },
  {
    "second": 103.36827183300001,
    "label": "Explore",
    "x": 258.59375,
    "y": 31.5,
    "width": 101.125,
    "height": 38.84375
  },
  {
    "second": 103.985709,
    "label": "Model A \u00b7 Linear\nPending",
    "x": 222,
    "y": 320.078125,
    "width": 246,
    "height": 44
  },
  {
    "second": 104.513586208,
    "label": "Make live",
    "x": 1033.0625,
    "y": 732.4609375,
    "width": 82.125,
    "height": 34.296875
  },
  {
    "second": 105.990936375,
    "label": "Switch runtime",
    "x": 959.7421875,
    "y": 488.8515625,
    "width": 118.515625,
    "height": 34.296875
  },
  {
    "second": 117.54268800000001,
    "label": "Model B \u00b7 Ridge\nPending",
    "x": 222,
    "y": 364.078125,
    "width": 246,
    "height": 44
  },
  {
    "second": 118.103949458,
    "label": "Make live",
    "x": 1033.0625,
    "y": 732.4609375,
    "width": 82.125,
    "height": 34.296875
  },
  {
    "second": 119.6068565,
    "label": "Switch runtime",
    "x": 959.7421875,
    "y": 498.2734375,
    "width": 118.515625,
    "height": 34.296875
  },
  {
    "second": 132.34571004199998,
    "label": "Generate future\n\u2318\u21b5",
    "x": 1500.03125,
    "y": 616.4375,
    "width": 143.9375,
    "height": 48
  },
  {
    "second": 139.30968124999998,
    "label": "Input experiment\nPending",
    "x": 222,
    "y": 408.078125,
    "width": 246,
    "height": 44
  },
  {
    "second": 139.873181083,
    "label": "Make live",
    "x": 1033.0625,
    "y": 732.4609375,
    "width": 82.125,
    "height": 34.296875
  },
  {
    "second": 141.375269667,
    "label": "Switch runtime",
    "x": 959.7421875,
    "y": 498.2734375,
    "width": 118.515625,
    "height": 34.296875
  },
  {
    "second": 142.598017208,
    "label": "Check input",
    "x": 900.4609375,
    "y": 774.5234375,
    "width": 110.921875,
    "height": 38.296875
  },
  {
    "second": 150.443843083,
    "label": "Generate future\n\u2318\u21b5",
    "x": 1500.03125,
    "y": 639.828125,
    "width": 143.9375,
    "height": 48
  },
  {
    "second": 157.22798299999997,
    "label": "Inspect",
    "x": 1486.234375,
    "y": 702.9765625,
    "width": 41.875,
    "height": 17.390625
  },
  {
    "second": 157.735930833,
    "label": "Logs",
    "x": 1354.625,
    "y": 215.84375,
    "width": 144.25,
    "height": 33.9375
  },
  {
    "second": 166.34549383299998,
    "label": "Generate future\n\u2318\u21b5",
    "x": 1500.03125,
    "y": 611.890625,
    "width": 143.9375,
    "height": 48
  },
  {
    "second": 173.97543579199998,
    "label": "Hardened input\nPending",
    "x": 222,
    "y": 496.078125,
    "width": 246,
    "height": 44
  },
  {
    "second": 174.56470575,
    "label": "Tests",
    "x": 1399.1015625,
    "y": 215.84375,
    "width": 114.609375,
    "height": 33.9375
  },
  {
    "second": 179.215484875,
    "label": "Diff",
    "x": 1161.8984375,
    "y": 215.84375,
    "width": 114.609375,
    "height": 33.9375
  },
  {
    "second": 183.52682820799998,
    "label": "Hardened input\nPending",
    "x": 222,
    "y": 496.078125,
    "width": 246,
    "height": 44
  },
  {
    "second": 184.051356875,
    "label": "Make live",
    "x": 1033.0625,
    "y": 732.4609375,
    "width": 82.125,
    "height": 34.296875
  },
  {
    "second": 185.539919375,
    "label": "Switch runtime",
    "x": 959.7421875,
    "y": 498.2734375,
    "width": 118.515625,
    "height": 34.296875
  },
  {
    "second": 187.25696858299997,
    "label": "Check input",
    "x": 900.4609375,
    "y": 774.5234375,
    "width": 110.921875,
    "height": 38.296875
  },
  {
    "second": 191.927377667,
    "label": "Check input",
    "x": 900.4609375,
    "y": 627.5234375,
    "width": 110.921875,
    "height": 38.296875
  },
  {
    "second": 197.62903808299998,
    "label": "Original\nRoot",
    "x": 222,
    "y": 276.078125,
    "width": 246,
    "height": 44
  },
  {
    "second": 198.18591866699998,
    "label": "Snapshots",
    "x": 1517.703125,
    "y": 215.84375,
    "width": 114.59375,
    "height": 33.9375
  },
  {
    "second": 198.684940625,
    "label": "Restore",
    "x": 1522.234375,
    "y": 556.5234375,
    "width": 71.53125,
    "height": 34.296875
  },
  {
    "second": 200.177827542,
    "label": "Restore and go live",
    "x": 946.421875,
    "y": 498.2734375,
    "width": 145.15625,
    "height": 34.296875
  }
]
```

## Reproduction and recovery
1. Use the isolated worktree and its local Python/Studio dependencies. Do not point at another engine or existing state.
2. Run `node scripts/primary_demo/run.mjs` for a fresh disposable rehearsal.
3. Run `node scripts/primary_demo/run.mjs --record` for a new take, then `.venv/bin/python scripts/primary_demo/produce.py` and `node scripts/primary_demo/verify-video.mjs`.
4. Every run refuses occupied ports and creates a unique state directory. No state is reused; no generation is silently retried.
5. A failed run records its error and screenshot. Fix the isolated script/workload only, then rerun into a NEW directory. Do not fabricate a successful state or relabel failed evidence.
6. Only Scripted generation is permitted; paid credentials are omitted. All browser traffic is restricted to the new loopback engine/Studio origins.
7. If ports 8056/5216 are unavailable, set `PARADOX_PRIMARY_ENGINE_PORT` / `PARADOX_PRIMARY_STUDIO_PORT` to unused loopback ports. Protected/default recording ports are refused.
8. Verify saved state and source changes using the assertions and milestone files in the take. Stop only the processes launched by this script.
9. Never remove or rewrite any existing backup recording/environment. Recheck preservation-before.json using preserve.py.
10. The failed security generation must have no adopted timeline; hardening must be a child of the unsafe timeline, not of the failed record.

## Preparation and timing
Model A is genuinely generated before capture so the opening already contains an alternate future. Original note and snapshot are seeded through real local APIs before capture. Model B, unsafe, failed check and hardened generations are submitted through the visible Studio during this take. A transient Original notebook note is added through the real API during scene02; restoration is asserted to remove it and recover the saved posts.
Normal waits and readable dwell remain in this full-length cut; no synthetic cursor or fabricated application panel is used.
