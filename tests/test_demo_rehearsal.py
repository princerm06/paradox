import importlib.util
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

import httpx
import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/demo_rehearsal.py"


def verify_cleanup(output):
    pid = int(re.search(r"Engine PID: (\d+)", output).group(1))
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
    state = Path(re.search(r"State directory: (.+)", output).group(1))
    assert not state.parent.exists()
    url = re.search(r"App URL: (\S+)", output).group(1)
    with httpx.Client(trust_env=False, timeout=1) as client:
        with pytest.raises(httpx.TransportError):
            client.get(url)


def test_scripted_demo_rehearsal_runs_over_http_and_cleans_up():
    environment = os.environ.copy()
    environment.pop("FACTORY_API_KEY", None)
    environment["PARADOX_AGENT"] = "droid"
    environment["PARADOX_TOKEN"] = "must-not-be-forwarded"
    environment["PARADOX_APP_URL"] = "https://invalid.example/app/"
    result = subprocess.run([sys.executable, str(SCRIPT)], cwd=ROOT, env=environment,
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS: all scripted demo checks completed" in result.stdout
    assert "FAIL:" not in result.stdout + result.stderr
    verify_cleanup(result.stdout)


def test_rehearsal_failure_reports_nonzero_and_cleans_up(monkeypatch, capsys):
    spec = importlib.util.spec_from_file_location("rehearsal", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    def fail(client):
        raise RuntimeError("intentional rehearsal failure")

    monkeypatch.setattr(module, "rehearse", fail)
    assert module.main([]) == 1
    captured = capsys.readouterr()
    assert "FAIL: intentional rehearsal failure" in captured.err
    verify_cleanup(captured.out)


def test_keep_running_stays_available_until_interruption_and_cleans_up(tmp_path):
    output_path = tmp_path / "rehearsal.log"
    with output_path.open("w") as output:
        process = subprocess.Popen([sys.executable, str(SCRIPT), "--keep-running"],
                                   cwd=ROOT, stdout=output, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                text = output_path.read_text()
                if "Demo ready." in text:
                    break
                assert process.poll() is None, text
                time.sleep(0.1)
            else:
                pytest.fail("Human demo did not become ready: " + text)
            url = re.search(r"App URL: (\S+)", text).group(1)
            with httpx.Client(trust_env=False) as client:
                assert client.get(url).status_code == 200
                assert client.get(url + "api/posts").json()["ordering"] == "popular"
            process.send_signal(signal.SIGTERM)
            assert process.wait(timeout=30) == 0
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                process.wait(timeout=30)
    verify_cleanup(output_path.read_text())
