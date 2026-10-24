import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import time

from engine.jobs import log_line, redact, scrubbed_environment
from engine import droid_sandbox


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
            elif (sandbox_reason := droid_sandbox.availability_reason()):
                reason = sandbox_reason
            else:
                try:
                    version = subprocess.run([shutil.which("node"), "--version"], capture_output=True, timeout=5, env=scrubbed_environment())
                    if version.returncode:
                        return {"id": provider, "available": False, "reason": "Node.js version probe failed"}
                    if int(version.stdout.decode().strip().lstrip("v").split(".")[0]) < 20:
                        return {"id": provider, "available": False, "reason": "Droid SDK adapter requires Node.js >=20"}
                    probe = subprocess.run([shutil.which("node"), str(ADAPTER), "--probe"], capture_output=True, timeout=10, env=scrubbed_environment())
                    report = json.loads(probe.stdout)
                    if not isinstance(report, dict) or not all(report.get(key) is True for key in ("ok", "sdk", "droid_cli")):
                        detail = report.get("detail") if isinstance(report, dict) else None
                        reason = "Droid SDK adapter probe failed" + (": " + redact(detail)[:500] if isinstance(detail, str) else "")
                    elif probe.returncode:
                        reason = "Droid SDK adapter dependencies are unavailable; run npm ci && npm run build"
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    reason = "Droid SDK adapter probe failed"
        else:
            reason = "optional Claude provider is not enabled" if provider == "claude" else "unknown provider"
        return {"id": provider, "available": reason is None, "reason": reason}

    def listing(self):
        return {"default": self.default, "providers": [self.availability(name) for name in ("droid", "scripted", "claude")]}

    def run(self, provider, prompt, code, control, log):
        if provider not in {"scripted", "droid"}:
            raise ValueError("Unknown or disabled agent provider: " + provider)
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
            control.check()
            command, environment = droid_sandbox.prepare(code, [shutil.which("node"), str(ADAPTER)], scrubbed_environment("droid"))
            log_line(log, 'Droid macOS write sandbox verified: demo_app only; private Factory home and scratch; network allowed')
            control.check()
            exit_code = control.run(command, code, log, 300, environment, payload)
            result = None
            with log.open(encoding="utf-8", errors="replace") as output:
                for line in output:
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(event, dict) and event.get("type") == "result":
                        if result is not None:
                            raise RuntimeError("Droid SDK adapter emitted multiple results")
                        result = self.adapter_result(event)
            if result is None:
                raise RuntimeError(f"Droid SDK adapter produced no result (exit {exit_code})")
            if exit_code:
                result["exit_code"] = exit_code
        result["duration_ms"] = round((time.monotonic() - started) * 1000)
        return result

    @staticmethod
    def adapter_result(event):
        exit_code = event.get("exit_code")
        session_id = event.get("session_id")
        summary = event.get("summary")
        usage = event.get("usage")
        if type(exit_code) is not int or exit_code < 0:
            raise RuntimeError("Droid SDK adapter result has an invalid exit_code")
        if session_id is not None and not isinstance(session_id, str):
            raise RuntimeError("Droid SDK adapter result has an invalid session_id")
        if exit_code == 0 and not session_id:
            raise RuntimeError("Successful Droid SDK adapter result has no session_id")
        if summary is not None and not isinstance(summary, str):
            raise RuntimeError("Droid SDK adapter result has an invalid summary")
        if not isinstance(usage, dict):
            raise RuntimeError("Droid SDK adapter result has invalid usage")
        normalized_usage = {}
        for key in ("input_tokens", "output_tokens", "factory_credits"):
            value = usage.get(key)
            if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or value < 0):
                raise RuntimeError("Droid SDK adapter result has invalid " + key)
            normalized_usage[key] = value
        return {"exit_code": exit_code, "session_id": session_id, "summary": redact(summary) if summary is not None else None, "usage": normalized_usage}
