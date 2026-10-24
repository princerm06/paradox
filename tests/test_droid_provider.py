import json
from pathlib import Path
import shutil
import subprocess
import time

from fastapi.testclient import TestClient
import pytest

from engine.api import create_app
from engine import providers
from engine.jobs import JobControl, scrubbed_environment
from engine.providers import Providers
from engine.validation import changes, guard


def test_sdk_success_without_source_edits_still_fails_guard():
    source = {"demo_app/ranking.py": b"ORDERING = 'chronological'\n"}
    changed, patch = changes(source, dict(source))
    assert patch == ""
    with pytest.raises(ValueError, match="Agent made no code changes"):
        guard(source, dict(source), changed)


@pytest.fixture
def adapter(tmp_path, monkeypatch):
    if not shutil.which("node"):
        pytest.skip("Node.js is required for adapter protocol tests")
    path = tmp_path / "adapter.cjs"
    monkeypatch.setattr(providers, "ADAPTER", path)
    monkeypatch.setenv("FACTORY_API_KEY", "test-only-droid-provider-key")
    monkeypatch.setenv("PARADOX_AGENT", "droid")
    monkeypatch.setattr(providers.droid_sandbox, "availability_reason", lambda: None)
    monkeypatch.setattr(providers.droid_sandbox, "prepare", lambda code, command, environment: (command, environment))
    monkeypatch.delenv("PARADOX_TOKEN", raising=False)
    original_which = shutil.which
    monkeypatch.setattr(shutil, "which", lambda command: "/test/droid" if command == "droid" else original_which(command))
    return path


def write_adapter(path, body):
    path.write_text(
        "if(process.argv.includes('--probe')) { console.log(JSON.stringify({ok:true,sdk:true,droid_cli:true,detail:null})); } else {\n"
        + body + "\n}\n"
    )


def terminal(client, generation_id):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        response = client.get("/api/generations/" + generation_id)
        assert response.status_code == 200
        record = response.json()
        if record["status"] in {"failed", "cancelled", "succeeded"}:
            return record
        time.sleep(.02)
    raise AssertionError("Generation did not become terminal")


def submit(client):
    root = client.get("/api/timelines").json()["active_timeline_id"]
    response = client.post("/api/generations", json={"parent_id": root, "provider": "droid", "prompt": "Rank the feed by popularity. Add a test."})
    assert response.status_code == 202, response.text
    return response.json()["id"]


def app(tmp_path):
    return create_app(state_dir=tmp_path / "state", runtime_port=0,
                      runtime_source=Path(__file__).parent / "fixtures/engine_demo")


def test_missing_credentials_is_accurate_and_never_falls_back(adapter, monkeypatch, tmp_path):
    write_adapter(adapter, "throw Error('must not run');")
    monkeypatch.delenv("FACTORY_API_KEY")
    with TestClient(app(tmp_path)) as client:
        available = client.get("/api/agents").json()
        assert available["default"] == "droid"
        droid = next(item for item in available["providers"] if item["id"] == "droid")
        assert not droid["available"] and "FACTORY_API_KEY" in droid["reason"]
        root = client.get("/api/timelines").json()["active_timeline_id"]
        for selection in ({"provider": "droid"}, {}):
            response = client.post("/api/generations", json={"parent_id": root, "prompt": "popular", **selection})
            assert response.status_code == 422 and "FACTORY_API_KEY" in response.json()["detail"]
        assert client.get("/api/generations").json()["generations"] == []


@pytest.mark.parametrize("output,reason", [
    ({"ok": False, "sdk": False, "droid_cli": True, "detail": "SDK import unavailable"}, "SDK import unavailable"),
    ({"ok": True, "sdk": False, "droid_cli": True}, "probe failed"),
    (["bad report"], "probe failed"),
    ("not JSON", "probe failed"),
])
def test_availability_rejects_bad_probe(adapter, monkeypatch, output, reason):
    adapter.touch()
    def run(command, **kwargs):
        payload = b"v24.0.0" if "--version" in command else (output.encode() if isinstance(output, str) else json.dumps(output).encode())
        return subprocess.CompletedProcess(command, 0, payload, b"")
    monkeypatch.setattr(subprocess, "run", run)
    result = Providers().availability("droid")
    assert not result["available"] and reason in result["reason"]


def test_availability_requires_node_20(adapter, monkeypatch):
    adapter.touch()
    monkeypatch.setattr(subprocess, "run", lambda command, **kwargs: subprocess.CompletedProcess(command, 0, b"v18.0.0", b""))
    assert "Node.js >=20" in Providers().availability("droid")["reason"]


@pytest.mark.parametrize("missing,reason", [("node", "Node.js is not installed"), ("droid", "droid CLI")])
def test_availability_reports_missing_executable(adapter, monkeypatch, missing, reason):
    adapter.touch()
    original_which = shutil.which
    monkeypatch.setattr(shutil, "which", lambda command: None if command == missing else original_which(command))
    result = Providers().availability("droid")
    assert not result["available"] and reason in result["reason"]


def test_availability_reports_missing_build(adapter):
    result = Providers().availability("droid")
    assert not result["available"] and "not built" in result["reason"]


def test_availability_probe_timeout_is_unavailable(adapter, monkeypatch):
    adapter.touch()
    def run(command, **kwargs):
        raise subprocess.TimeoutExpired(command, 10)
    monkeypatch.setattr(subprocess, "run", run)
    result = Providers().availability("droid")
    assert not result["available"] and "probe failed" in result["reason"]


def test_availability_failing_node_version_probe(adapter, monkeypatch):
    adapter.touch()
    monkeypatch.setattr(subprocess, "run", lambda command, **kwargs: subprocess.CompletedProcess(command, 1, b"v24.0.0", b""))
    assert Providers().availability("droid")["reason"] == "Node.js version probe failed"


@pytest.mark.parametrize("field,value", [
    ("exit_code", "0"), ("exit_code", True), ("session_id", None),
    ("usage", None), ("usage", {"factory_credits": -1}), ("summary", {}),
])
def test_invalid_results_fail_closed(field, value):
    result = {"exit_code": 0, "session_id": "sdk-session", "summary": "done", "usage": {}}
    result[field] = value
    with pytest.raises(RuntimeError, match="Droid SDK adapter"):
        Providers.adapter_result(result)


def test_sdk_failure_exposes_redacted_error_and_no_timeline(adapter, tmp_path):
    write_adapter(adapter, "console.log(JSON.stringify({type:'result',exit_code:1,session_id:'sdk-failed',summary:'SDK authentication rejected '+process.env.FACTORY_API_KEY,usage:{}}));process.exitCode=1;")
    with TestClient(app(tmp_path)) as client:
        record = terminal(client, submit(client))
        assert record["status"] == "failed" and record["error"]["stage"] == "agent"
        assert "SDK authentication rejected" in record["error"]["message"]
        assert "test-only-droid-provider-key" not in json.dumps(record)
        assert record["agent"]["session_id"] == "sdk-failed"
        assert record["timeline_id"] is None
        assert len(client.get("/api/timelines").json()["timelines"]) == 1
        logs = client.get(f"/api/generations/{record['id']}/logs").json()
        assert "test-only-droid-provider-key" not in json.dumps(logs)


def test_adapter_timeout_is_failed_agent_not_scripted(adapter, tmp_path, monkeypatch):
    write_adapter(adapter, "setInterval(()=>{},1000);")
    original = JobControl.run
    def shortened(self, command, cwd, log_path, timeout, environment=None, input_data=None):
        return original(self, command, cwd, log_path, .2, environment, input_data)
    monkeypatch.setattr(JobControl, "run", shortened)
    with TestClient(app(tmp_path)) as client:
        record = terminal(client, submit(client))
        assert record["provider"] == "droid" and record["status"] == "failed"
        assert record["error"]["stage"] == "agent" and "timeout" in record["error"]["message"]
        assert record["timeline_id"] is None
        assert len(client.get("/api/timelines").json()["timelines"]) == 1


def test_cancel_droid_is_terminal_and_preserves_parent(adapter, tmp_path):
    write_adapter(adapter, "console.log(JSON.stringify({type:'log',message:'SDK session waiting'}));setInterval(()=>{},1000);")
    with TestClient(app(tmp_path)) as client:
        generation_id = submit(client)
        deadline = time.monotonic() + 10
        while client.get("/api/generations/" + generation_id).json()["status"] != "generating":
            assert time.monotonic() < deadline
            time.sleep(.02)
        response = client.post(f"/api/generations/{generation_id}/cancel")
        assert response.status_code == 200 and response.json()["status"] == "cancelled"
        time.sleep(.3)
        record = terminal(client, generation_id)
        assert record["status"] == "cancelled" and record["timeline_id"] is None
        assert client.post(f"/api/generations/{generation_id}/cancel").status_code == 409
        assert len(client.get("/api/timelines").json()["timelines"]) == 1
        assert client.get("/api/health").json()["runtime_running"]


def test_unknown_provider_never_invokes_droid(tmp_path):
    with pytest.raises(ValueError, match="disabled agent provider"):
        Providers().run("claude", "popular", tmp_path, JobControl(), tmp_path / "agent.log")


def test_droid_model_override_is_not_forwarded_to_validation(monkeypatch):
    monkeypatch.setenv("PARADOX_DROID_MODEL", "claude-sonnet-4-6")
    assert scrubbed_environment("droid")["PARADOX_DROID_MODEL"] == "claude-sonnet-4-6"
    assert "PARADOX_DROID_MODEL" not in scrubbed_environment()


def test_sandbox_unavailable_is_reported_offline_without_fallback(adapter, monkeypatch):
    write_adapter(adapter, "throw Error('must not run');")
    monkeypatch.setattr(providers.droid_sandbox, 'availability_reason', lambda: 'macOS sandbox enforcement unavailable')
    result = Providers().availability('droid')
    assert not result['available']
    assert 'sandbox' in result['reason']


def test_sandbox_initialization_failure_is_agent_failure_without_fallback(adapter, tmp_path, monkeypatch):
    write_adapter(adapter, "throw Error('SDK must not start');")
    def fail_sandbox(*args):
        raise RuntimeError('Droid write sandbox enforcement failed; refusing to start the SDK')
    monkeypatch.setattr(providers.droid_sandbox, 'prepare', fail_sandbox)
    with TestClient(app(tmp_path)) as client:
        record = terminal(client, submit(client))
        assert record['provider'] == 'droid' and record['status'] == 'failed'
        assert record['error']['stage'] == 'agent'
        assert 'sandbox enforcement failed' in record['error']['message']
        assert record['timeline_id'] is None
        assert len(client.get('/api/timelines').json()['timelines']) == 1


def test_duplicate_results_are_rejected(adapter, tmp_path):
    write_adapter(adapter, "for(let index=0;index<2;index++)console.log(JSON.stringify({type:'result',exit_code:0,session_id:'session',summary:null,usage:{}}));")
    with pytest.raises(RuntimeError, match="multiple results"):
        Providers().run("droid", "popular", tmp_path, JobControl(), tmp_path / "agent.log")


def test_http_verifier_checks_code_database_and_revisit_without_paid_sdk(adapter, tmp_path):
    from engine.droid_adapter.verify_live import verify
    repository = Path(__file__).parents[1]
    recipe = json.loads((repository / "tests/fixtures/scripted_agent/popular_feed.json").read_text())
    body = (
        "const fs=require('node:fs'),path=require('node:path');"
        "for(const [file,content] of Object.entries(" + json.dumps(recipe["files"]) + ")){"
        "fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);}"
        "console.log(JSON.stringify({type:'result',exit_code:0,session_id:'offline-sdk-session',summary:'mock edit',usage:{}}));"
    )
    write_adapter(adapter, body)
    state = tmp_path / "verified-state"
    with TestClient(create_app(state_dir=state, runtime_port=0, runtime_source=repository / "demo_app")) as client:
        evidence = {"verified": False}
        verify(client, state, evidence)
        assert evidence["verified"]
        assert evidence["generation_post_attempts"] == 1
        assert evidence["generation"]["agent"]["session_id"] == "offline-sdk-session"
        assert evidence["source_hashes"]["parent"] != evidence["source_hashes"]["child"]
