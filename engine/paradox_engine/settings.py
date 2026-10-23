from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional


@dataclass
class Settings:
    home: Path = field(default_factory=lambda: Path(os.environ.get("PARADOX_HOME", str(Path(__file__).resolve().parents[2] / ".paradox"))))
    source_dir: Path = field(default_factory=lambda: Path(os.environ.get("PARADOX_SOURCE_DIR", str(Path(__file__).resolve().parents[2] / "demo_app"))))
    app_port: int = field(default_factory=lambda: int(os.environ.get("PARADOX_APP_PORT", "8100")))
    engine_port: int = field(default_factory=lambda: int(os.environ.get("PARADOX_ENGINE_PORT", "8000")))
    app_command: Optional[List[str]] = None
    health_path: str = "/healthz"
    health_timeout: float = 15.0
    lock_timeout: float = 30.0

    def __post_init__(self):
        self.home = Path(self.home).resolve()
        self.source_dir = Path(self.source_dir).resolve()
        if self.app_command is None:
            self.app_command = [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "{port}"]
