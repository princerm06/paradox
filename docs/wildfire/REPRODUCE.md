# Reproducing the NASA wildfire demonstration

This branch is base commit `6ecd978` (engine + redesigned Studio, unchanged) plus the
workload, Scripted recipes, recorder and documentation used for the Cal Hacks 13.0
recording. Those 25 files are byte-identical to the SHA-256 values recorded at capture
time (`VERIFICATION-REPORT.md`). This file was added afterward for publication.

All generations below use the deterministic **Scripted** provider. No Factory Droid call
or credential is involved.

## 1. App tests (Python 3.13)

```sh
python -m venv .venv && .venv/bin/pip install -r requirements-demo.txt -r requirements-dev.txt
.venv/bin/python -m pytest -q demo_app/tests      # expected: 20 passed
```

## 2. Engine sequence without a browser

Start an engine with the wildfire recipes and a fresh state directory:

```sh
export PARADOX_AGENT=scripted
export PARADOX_SCRIPTED_RECIPES="$PWD/tests/fixtures/scripted_agent/wildfire"
export PARADOX_SOURCE_DIR="$PWD/demo_app"
.venv/bin/python -c "from pathlib import Path; import uvicorn; from engine.api import create_app; \
uvicorn.run(create_app(state_dir=Path('/tmp/paradox-wildfire-state'), runtime_port=0), host='127.0.0.1', port=8056)"
```

Then submit Scripted generations through `POST /api/generations` with these prompts,
in this order:

| Prompt | Parent | Expected result |
|---|---|---|
| `wildfire model a` | Original | succeeded, 21 passed |
| `wildfire model b` | Original | succeeded, 21 passed |
| `wildfire unsafe input` | Model B timeline | succeeded, 22 passed; when active, `POST /app/api/wildfire/predict {"brightness": -10}` returns 200 |
| `wildfire security check` | unsafe timeline | **failed** at `tests`, 23 passed / 1 failed (`assert 200 == 422`), no timeline created |
| `wildfire harden input` | unsafe timeline | succeeded, 24 passed; when active, `-10` returns 422 and `330` returns 200 |

Expected held-out metrics (MW): Original MAE 8.356204 / RMSE 24.366925;
Model A 8.395625 / 22.254659; Model B 7.986002 / 21.725393.

## 3. Full browser recording

`scripts/primary_demo/run.mjs` drives the real Studio with Playwright. It needs
`apps/studio` dependencies (`npm ci`), a `.venv` at the repo root, and an output directory
set through `PARADOX_PRIMARY_OUTPUT`. Run `node scripts/primary_demo/run.mjs` for a rehearsal,
or add `--record` for a recorded take. Every run creates new disposable state.

`package.py` and `verify-video.mjs` are packaging and video-verification helpers from the
recording session. The video post-production and protected-recording preservation scripts
(`produce.py`, `preserve.py`) are **not published**: they depend on the recording machine.
`RECORDING-SCRIPT.md` still names them because that document is kept exactly as it was at capture.
Sections 1–2 above do not need them.

## Historical paths in recorded documents

`VERIFICATION-REPORT.md`, `RECORDING-SCRIPT.md` and `VISUAL-REVIEW.md` contain absolute
`/Users/...` paths to the original recording artifacts. They are left unchanged so the
documents still match their capture-time SHA-256 hashes. They are machine-specific and
not required to reproduce the workload.

## Data

`demo_app/data/nasa_viirs.csv` is a frozen NASA FIRMS Suomi NPP VIIRS C2 export
(1,198 rows, SHA-256 `66a3b9ea2f099b04d795292450a84710f57a17e0a23bfafc57b22e9ae82cd9c6`).
Its source, retrieval and limitations are in `demo_app/data/provenance.json` and `DATASET.md`.
The model estimates contemporaneous fire radiative power. It is not a wildfire-spread or
emergency-response forecast.
