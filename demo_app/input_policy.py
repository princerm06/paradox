import math

from fastapi import HTTPException

MODE = "baseline"
DESCRIPTION = "Finite brightness temperatures from 200 to 500 K only; constant-size local inference."


def validate_brightness(brightness):
    if not math.isfinite(brightness) or not 200 <= brightness <= 500:
        raise HTTPException(status_code=422, detail="brightness must be finite and between 200 and 500 K")
    return brightness
