import hashlib
import json
import math

import pytest

from demo_app import wildfire


def test_wildfire_feature_general(client, capsys):
    response = client.get("/api/wildfire")
    assert response.status_code == 200
    report = response.json()
    with capsys.disabled():
        print("MEASURED MODEL: " + report["model"]["label"])
        print("MAE={mae:.6f} MW | RMSE={rmse:.6f} MW | R2={r2:.6f}".format(**report["metrics"]))
        print("FROZEN EVALUATION: {} train / {} held-out rows; grouped UTC timestamps".format(
            report["dataset"]["train_rows"], report["dataset"]["test_rows"]))
        print("WILDFIRE_EVALUATION " + json.dumps({
            "model": report["model"], "metrics": report["metrics"],
            "dataset": report["dataset"],
        }, sort_keys=True))
    assert set(report) == {"model", "dataset", "metrics", "observations", "predictions", "security"}
    assert all(report["model"][key] for key in ("id", "label", "description"))
    dataset = report["dataset"]
    assert dataset["rows"] == 1198 == dataset["train_rows"] + dataset["test_rows"]
    assert dataset["source"].startswith("https://firms.modaps.eosdis.nasa.gov/")
    provenance = json.loads((wildfire.DATA_DIR / "provenance.json").read_text())
    assert hashlib.sha256((wildfire.DATA_DIR / "nasa_viirs.csv").read_bytes()).hexdigest() == dataset["sha256"] == provenance["sha256"]
    train = [row for row in report["observations"] if row["split"] == "train"]
    test = [row for row in report["observations"] if row["split"] == "test"]
    assert len(train) == dataset["train_rows"] and len(test) == dataset["test_rows"]
    assert max(row["acquired_at"] for row in train) < min(row["acquired_at"] for row in test)
    assert [row["frp"] for row in test] == [row["actual"] for row in report["predictions"]]
    actual = [row["actual"] for row in report["predictions"]]
    predicted = [row["predicted"] for row in report["predictions"]]
    assert all(math.isfinite(value) for value in predicted)
    for key, value in wildfire.evaluate(actual, predicted).items():
        assert report["metrics"][key] == pytest.approx(value)
    assert all(math.isfinite(value) for value in report["metrics"].values())
    assert report["metrics"]["train_ms"] >= 0 and report["metrics"]["inference_ms"] >= 0
    prediction = client.post("/api/wildfire/predict", json={"brightness": 330})
    assert prediction.status_code == 200
    assert math.isfinite(prediction.json()["prediction"])
    assert prediction.json()["model"] == report["model"]["label"]
    assert client.get("/api/health").json()["status"] == "ok"


def test_wildfire_split_groups_and_nonfinite_filter(tmp_path):
    path = tmp_path / "sample.csv"
    path.write_text("latitude,longitude,frp,bright_ti4,acq_date,acq_time\n"
                    "30,-110,1,330,2026-01-01,0100\n"
                    "31,-110,2,331,2026-01-01,0100\n"
                    "32,-110,3,332,2026-01-01,0200\n"
                    "32,-110,nan,332,2026-01-01,0300\n"
                    "32,-110,3,inf,2026-01-01,0300\n"
                    "32,-110,,332,2026-01-01,0300\n"
                    "32,-110,3,332,2026-01-01\n"
                    "32,-110,3,332,,0300\n")
    rows = wildfire.split_observations(wildfire.load_observations(path))
    assert [row["split"] for row in rows] == ["train", "train", "test"]
