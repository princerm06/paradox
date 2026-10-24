import json
import os
from pathlib import Path
import shutil
import subprocess
import time

from engine.jobs import log_line, scrubbed_environment


ADAPTER = Path(__file__).with_name("droid_adapter") / "dist" / "adapter.js"


class Providers:
    def __init__(self):
        self.default = os.environ.get("PARADOX_AGENT", "droid")
        self.recipes = Path(os.environ.get("PARADOX_SCRIPTED_RECIPES", "tests/fixtures/scripted_agent")).resolve()

    def availability(self, provider):
        if provider == "scripted":
            reason = None if self.recipes.is_dir() and any(self.recipes.glob("*.json")) else "scripted recipe directory is missing or empty"
        elif provider == "droid":
            reason = None
            if not shutil.which("node"):
                reason = "Node.js is not installed"
            elif not ADAPTER.is_file():
                reason = "Droid SDK adapter is not built; run npm ci && npm run build in engine/droid_adapter"
            elif not shutil.which("droid"):
                reason = "droid CLI required by the official SDK is not installed on PATH"
            elif not os.environ.get("FACTORY_API_KEY"):
                reason = "FACTORY_API_KEY is not configured"
            else:
                try:
                    version = subprocess.run([shutil.which("node"), "--version"], capture_output=True, timeout=5, env=scrubbed_environment())
                    if int(version.stdout.decode().strip().lstrip("v").split(".")[0]) < 20:
                        return {"id": provider, "available": False, "reason": "Droid SDK adapter requires Node.js >=20"}
                    probe = subprocess.run([shutil.which("node"), str(ADAPTER), "--probe"], capture_output=True, timeout=10, env=scrubbed_environment())
                    if probe.returncode:
                        reason = "Droid SDK adapter dependencies are unavailable; run npm ci && npm run build"
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    reason = "Droid SDK adapter probe failed"
        else:
            reason = "optional Claude provider is not enabled" if provider == "claude" else "unknown provider"
        return {"id": provider, "available": reason is None, "reason": reason}

    def listing(self):
        return {"default": self.default, "providers": [self.availability(name) for name in ("droid", "scripted", "claude")]}

    def run(self, provider, prompt, code, control, log):
        started = time.monotonic()
        if provider == "scripted":
            recipe = None
            for path in sorted(self.recipes.glob("*.json")):
                candidate = json.loads(path.read_text())
                if str(candidate["match"]).lower() in prompt.lower():
                    recipe = candidate
                    break
            if recipe is None:
                raise ValueError("No scripted recipe matched the prompt")
            delay = float(recipe.get("delay_s", 0))
            if not 0 <= delay <= 300:
                raise ValueError("Recipe delay must be between 0 and 300 seconds")
            log_line(log, "Scripted recipe selected")
            if control.event.wait(delay):
                control.check()
            for relative, content in recipe.get("files", {}).items():
                control.check()
                relative_path = Path(relative)
                if relative_path.is_absolute() or ".." in relative_path.parts:
                    raise ValueError("Recipe paths must stay within the code workspace")
                destination = code / relative_path
                if any(parent.is_symlink() for parent in (destination, *destination.parents)):
                    raise ValueError("Recipe paths may not traverse symlinks")
                if content is None:
                    destination.unlink(missing_ok=True)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_text(content, encoding="utf-8")
            result = {"exit_code": 0, "session_id": None, "summary": recipe.get("summary", "Scripted edit applied"), "usage": {"input_tokens": None, "output_tokens": None, "factory_credits": None}}
        else:
            wrapped = (
                "Read demo_app/AGENTS.md first. Change only demo_app/. Add a test. "
                "Do not modify or delete existing tests or AGENTS.md. Do not run commands, installs, git, or external tools.\n\n"
                + prompt
            )
            payload = json.dumps({"cwd": str(code), "prompt": wrapped}).encode()
            exit_code = control.run([shutil.which("node"), str(ADAPTER)], code, log, 300, scrubbed_environment("droid"), payload)
            result = None
            with log.open(encoding="utf-8", errors="replace") as output:
                for line in output:
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    if event.get("type") == "result":
                        result = {key: event.get(key) for key in ("exit_code", "session_id", "summary", "usage")}
            if result is None:
                raise RuntimeError(f"Droid SDK adapter produced no result (exit {exit_code})")
            if exit_code:
                result["exit_code"] = exit_code
        result["duration_ms"] = round((time.monotonic() - started) * 1000)
        return result
