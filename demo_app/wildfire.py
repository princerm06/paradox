import csv
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean
from time import perf_counter

from demo_app import input_policy, model

DATA_DIR = Path(__file__).with_name("data")


def load_observations(path):
    observations = []
    with path.open(newline="", encoding="utf-8") as source:
        for row in csv.DictReader(source):
            try:
                values = {key: float(row[key]) for key in ("latitude", "longitude", "frp", "bright_ti4")}
                if not all(math.isfinite(value) for value in values.values()):
                    continue
                if not (-90 <= values["latitude"] <= 90 and -180 <= values["longitude"] <= 180):
                    continue
                if values["frp"] < 0 or not 200 <= values["bright_ti4"] <= 500:
                    continue
                if not row["acq_date"] or not row["acq_time"]:
                    continue
                acquired = datetime.strptime(row["acq_date"] + row["acq_time"].zfill(4), "%Y-%m-%d%H%M")
                values["acquired_at"] = acquired.replace(tzinfo=timezone.utc).isoformat()
                observations.append(values)
            except (KeyError, ValueError, TypeError):
                continue
    return sorted(observations, key=lambda row: (row["acquired_at"], row["latitude"], row["longitude"]))


def split_observations(observations):
    timestamps = sorted({row["acquired_at"] for row in observations})
    if len(timestamps) < 2:
        raise ValueError("Need at least two distinct acquisition timestamps")
    cutoff = timestamps[max(1, min(len(timestamps) - 1, int(len(timestamps) * 0.8)))]
    return [dict(row, split="train" if row["acquired_at"] < cutoff else "test") for row in observations]


def evaluate(actual, predicted):
    errors = [target - estimate for target, estimate in zip(actual, predicted)]
    squared_error = sum(error * error for error in errors)
    total = sum((target - mean(actual)) ** 2 for target in actual)
    return {
        "mae": mean(abs(error) for error in errors),
        "rmse": math.sqrt(squared_error / len(actual)),
        "r2": 1 - squared_error / total if total else (1.0 if squared_error == 0 else 0.0),
    }


def build_report():
    path = DATA_DIR / "nasa_viirs.csv"
    provenance = json.loads((DATA_DIR / "provenance.json").read_text())
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != provenance["sha256"]:
        raise ValueError("Frozen NASA CSV hash mismatch")
    observations = split_observations(load_observations(path))
    training = [row for row in observations if row["split"] == "train"]
    testing = [row for row in observations if row["split"] == "test"]
    started = perf_counter()
    fitted = model.fit(training)
    train_ms = (perf_counter() - started) * 1000
    started = perf_counter()
    predicted = [float(model.predict(fitted, row["bright_ti4"])) for row in testing]
    inference_ms = (perf_counter() - started) * 1000
    actual = [row["frp"] for row in testing]
    metrics = dict(evaluate(actual, predicted), train_ms=train_ms, inference_ms=inference_ms)
    if not all(math.isfinite(value) for value in metrics.values()):
        raise ValueError("Nonfinite model metrics")
    return fitted, {
        "model": {"id": model.MODEL_ID, "label": model.MODEL_LABEL, "description": model.MODEL_DESCRIPTION},
        "dataset": {
            "source": provenance["source"], "label": "NASA FIRMS Suomi NPP VIIRS C2 · frozen 24h export",
            "sha256": digest, "rows": len(observations),
            "window_start": observations[0]["acquired_at"], "window_end": observations[-1]["acquired_at"],
            "train_rows": len(training), "test_rows": len(testing),
            "split": "First floor(80% of distinct UTC timestamps) train; remaining timestamps test; no timestamp overlaps.",
            "units": {"frp": "MW", "bright_ti4": "K", "latitude": "degrees north", "longitude": "degrees east", "acquired_at": "UTC"},
            "limitation": "Same-time brightness and FRP are radiometrically related. This estimates contemporaneous FRP, NOT fire spread, evacuation, or future fire risk. Satellite detections include non-wildfire thermal anomalies; coverage, clouds and saturation limit interpretation.",
        },
        "metrics": metrics, "observations": observations,
        "predictions": [{"actual": target, "predicted": estimate} for target, estimate in zip(actual, predicted)],
        "security": {"mode": input_policy.MODE, "description": input_policy.DESCRIPTION},
    }
