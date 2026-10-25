from statistics import mean

MODEL_ID = "original"
MODEL_LABEL = "Original · train mean"
MODEL_DESCRIPTION = "Training-only mean FRP; contemporaneous estimation, not a forecast."


def fit(rows):
    return mean(row["frp"] for row in rows)


def predict(fitted, brightness):
    return fitted
