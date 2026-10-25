from dataclasses import replace
import json
from pathlib import Path
import types

import pytest

import engine
from engine.adapters.fastapi_sqlite import ADAPTER
from engine.jobs import Cancelled, scrubbed_environment
from engine.providers import Providers


@pytest.fixture
def imported_agent(tmp_path, monkeypatch):
    profile = replace(ADAPTER.profile({
        "adapter": "fastapi-sqlite-v1", "app": "notes_app.main:app", "working_dir": ".",
        "tests": "tests", "health_path": "/health", "state_env": "PARADOX_APP_DIR",
    }), providers=("scripted", "droid"))
    code = tmp_path / "future" / "code"
    (code / "notes_app").mkdir(parents=True)
    (code / "tests").mkdir()
    (code / "requirements.txt").write_text("fastapi\n")
    (code / "tests/test_original.py").write_text("def test_original(): pass\n")
    monkeypatch.setenv("FACTORY_API_KEY", "offline-only-dummy-factory-key")
    monkeypatch.setenv("PARADOX_TOKEN", "offline-only-engine-token")
    monkeypatch.setenv("PARADOX_SHELL_TOKEN", "offline-only-shell-token")
    monkeypatch.setenv("PARADOX_IMPORTED_DROID_ENABLED", "1")
    prepared = []

    def prepare(workspace, command, environment, supplied_profile):
        prepared.append((workspace, command, environment.copy(), supplied_profile))
        return ["mock-sandbox", *command], dict(environment, PARADOX_DROID_SANDBOX="macos-project-write-v1")

    helper = types.SimpleNamespace(
        protected_files=lambda workspace, supplied_profile: ("requirements.txt", "tests/test_original.py"),
        prepare=prepare,
        cleanup=lambda workspace: prepared.append(("cleanup", workspace)),
    )
    monkeypatch.setattr(engine, "imported_agent_sandbox", helper, raising=False)
    return code, profile, prepared, tmp_path / "agent.log"


class MockSdkControl:
    def __init__(self, failure=None, exit_code=0):
        self.failure = failure
        self.exit_code = exit_code
        self.calls = []

    def check(self):
        pass

    def run(self, command, cwd, log, timeout, environment, input_data):
        self.calls.append((command, cwd, timeout, environment, json.loads(input_data)))
        if self.failure:
            raise self.failure
        request = self.calls[-1][-1]
        if not self.exit_code:
            (cwd / "notes_app/feature.py").write_text("FEATURE = 'mocked SDK edit'\n")
        with log.open("a") as output:
            for event in [
                {"type": "log", "message": "permission proceed_once: isolated file"},
                {"type": "result", "exit_code": self.exit_code, "session_id": "mock-sdk-session",
                 "summary": "Implemented: " + request["prompt"].split("\n\n")[-1],
                 "usage": {"input_tokens": None, "output_tokens": None, "factory_credits": None}},
            ]:
                output.write(json.dumps(event) + "\n")
        return self.exit_code


def test_imported_droid_payload_preserves_open_ended_request_and_isolated_scope(imported_agent):
    code, profile, prepared, log = imported_agent
    control = MockSdkControl()
    prompt = "Add a due-date summary endpoint, using a design you choose. Add tests."
    result = Providers().run("droid", prompt, code, control, log, profile)
    command, cwd, timeout, environment, request = control.calls[0]
    assert cwd == code and timeout == 300 and command[0] == "mock-sandbox"
    assert request["cwd"] == str(code) and request["prompt"].endswith(prompt)
    assert "demo_app" not in request["prompt"]
    assert request["project"] == {
        "adapter": "fastapi-sqlite-v1", "editable_prefixes": list(profile.editable_prefixes),
        "immutable_paths": list(profile.immutable_paths),
        "protected_files": ["requirements.txt", "tests/test_original.py"],
    }
    assert prepared[0][0] == code and prepared[0][3] == profile
    assert prepared[-1] == ("cleanup", code)
    assert environment["FACTORY_API_KEY"] == "offline-only-dummy-factory-key"
    assert not {"PARADOX_TOKEN", "PARADOX_SHELL_TOKEN", "PARADOX_IMPORTED_DROID_ENABLED"}.intersection(environment)
    assert environment["PARADOX_DROID_SANDBOX"] == "macos-project-write-v1"
    assert result["session_id"] == "mock-sdk-session" and result["exit_code"] == 0
    assert result["usage"]["factory_credits"] is None
    assert (code / "notes_app/feature.py").is_file()
    assert "offline-only-dummy-factory-key" not in log.read_text()
    assert not {"FACTORY_API_KEY", "PARADOX_TOKEN", "PARADOX_SHELL_TOKEN"}.intersection(scrubbed_environment())


@pytest.mark.parametrize("enabled", [None, "", "true", "0"])
def test_imported_droid_operator_opt_in_is_explicit_and_offline(imported_agent, monkeypatch, enabled):
    code, profile, prepared, log = imported_agent
    if enabled is None:
        monkeypatch.delenv("PARADOX_IMPORTED_DROID_ENABLED", raising=False)
    else:
        monkeypatch.setenv("PARADOX_IMPORTED_DROID_ENABLED", enabled)
    provider = Providers()
    availability = provider.availability("droid", profile)
    assert availability["available"] is False and "operator opt-in" in availability["reason"]
    control = MockSdkControl()
    with pytest.raises(ValueError, match="operator opt-in"):
        provider.run("droid", "An arbitrary feature request", code, control, log, profile)
    assert not prepared and not control.calls and not log.exists()


@pytest.mark.parametrize("failure", [Cancelled("cancelled mock SDK"), TimeoutError("SDK deadline"), RuntimeError("SDK unavailable")])
def test_imported_droid_failure_does_not_run_a_scripted_fallback(imported_agent, failure):
    code, profile, prepared, log = imported_agent
    original = (code / "tests/test_original.py").read_bytes()
    control = MockSdkControl(failure=failure)
    with pytest.raises(type(failure), match=str(failure)):
        Providers().run("droid", "prioritize notes", code, control, log, profile)
    assert len(prepared) == 2 and len(control.calls) == 1
    assert prepared[-1] == ("cleanup", code)
    assert not (code / "notes_app/feature.py").exists()
    assert (code / "tests/test_original.py").read_bytes() == original


def test_imported_droid_declined_sdk_result_remains_a_failure(imported_agent):
    code, profile, prepared, log = imported_agent
    result = Providers().run("droid", "Request requiring denied permission", code, MockSdkControl(exit_code=1), log, profile)
    assert result["exit_code"] == 1 and result["session_id"] == "mock-sdk-session"
    assert not (code / "notes_app/feature.py").exists()


def test_imported_droid_sandbox_failure_never_starts_sdk(imported_agent, monkeypatch):
    code, profile, prepared, log = imported_agent

    def unavailable(*arguments):
        raise RuntimeError("Imported agent sandbox failed enforcement")

    monkeypatch.setattr(engine.imported_agent_sandbox, "prepare", unavailable)
    control = MockSdkControl()
    with pytest.raises(RuntimeError, match="sandbox failed enforcement"):
        Providers().run("droid", "Implement a feature", code, control, log, profile)
    assert not control.calls
    assert prepared == [("cleanup", code)]


def test_imported_droid_inventory_failure_still_cleans_private_artifacts(imported_agent, monkeypatch):
    code, profile, prepared, log = imported_agent

    def invalid_inventory(*arguments):
        raise RuntimeError("unsafe project inventory")

    monkeypatch.setattr(engine.imported_agent_sandbox, "protected_files", invalid_inventory)
    control = MockSdkControl()
    with pytest.raises(RuntimeError, match="unsafe project inventory"):
        Providers().run("droid", "Implement a feature", code, control, log, profile)
    assert prepared == [("cleanup", code)] and not control.calls
