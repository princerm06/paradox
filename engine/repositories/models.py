from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Registration(StrictModel):
    path: str = Field(min_length=1, max_length=4096)


class AdapterConfig(StrictModel):
    adapter: Literal["fastapi-sqlite-v1"]
    app: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*:[A-Za-z_][A-Za-z0-9_]*$")
    working_dir: str = "."
    tests: str = "tests"
    health_path: str = "/health"
    state_env: Literal["PARADOX_APP_DIR"]


class ValidationRequest(StrictModel):
    configuration: Optional[AdapterConfig] = None
