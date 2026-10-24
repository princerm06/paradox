import hashlib
from pathlib import Path
import threading
import time
from urllib.parse import urlsplit

from fastapi.testclient import TestClient
import pytest

from engine.api import create_app


ROOT = Path(__file__).resolve().parents[1]
TERMINAL = {"succeeded", "failed", "cancelled"}


@pytest.fixture
def configuration(tmp_path, monkeypatch):
    monkeypatch.setenv("PARADOX_AGENT", "scripted")
    monkeypatch.setenv("PARADOX_SCRIPTED_RECIPES", str(ROOT / "tests/fixtures/scripted_agent"))
    for variable in ("PARADOX_TOKEN", "PARADOX_APP_URL", "PARADOX_CORS_ORIGINS"):
        monkeypatch.delenv(variable, raising=False)
    return {"state_dir": tmp_path / "state", "runtime_port": 0, "runtime_source": ROOT / "demo_app"}


@pytest.fixture
def client(configuration):
    with TestClient(create_app(**configuration)) as connection:
        yield connection


def call(client, method, path, status=200, **kwargs):
    response = client.request(method, path, **kwargs)
    assert response.status_code == status, response.text
    return response.json()


def listing(client):
    return call(client, "GET", "/api/timelines")


def feed(client):
    return call(client, "GET", "/app/api/posts")


def publish(client, content):
    return call(client, "POST", "/app/api/posts", 201, json={"author": "Audit", "content": content})


def activate(client, timeline_id):
    return call(client, "POST", f"/api/timelines/{timeline_id}/activate")


def sprout(client, **fields):
    return call(client, "POST", "/api/timelines/sprout", 201, json={"modification": "none", **fields})


def generate(client, parent_id, **fields):
    return call(client, "POST", "/api/generations", 202, json={
        "parent_id": parent_id, "prompt": "Make the feed popular", "provider": "scripted", **fields,
    })["id"]


def finish(client, generation_id):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        result = call(client, "GET", f"/api/generations/{generation_id}")
        with client.app.state.generations.lock:
            worker_finished = generation_id not in client.app.state.generations.controls
        if result["status"] in TERMINAL and worker_finished:
            return result
        time.sleep(0.02)
    raise AssertionError(f"Generation did not finish: {result}")


def digest(directory):
    return {
        path.relative_to(directory).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in directory.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
    }


def pause_adoption(client, monkeypatch):
    entered = threading.Event()
    release = threading.Event()
    generations = client.app.state.generations
    original = generations.adopt

    def paused(*args, **kwargs):
        entered.set()
        if not release.wait(20):
            raise RuntimeError("Audit adoption barrier timed out")
        return original(*args, **kwargs)

    monkeypatch.setattr(generations, "adopt", paused)
    return entered, release


def assert_preview(client, timeline_id, ordering):
    timelines = listing(client)
    assert timelines["active_timeline_id"] == timeline_id
    assert [item["id"] for item in timelines["timelines"] if item["is_active"]] == [timeline_id]
    assert call(client, "GET", "/api/health")["active_timeline_id"] == timeline_id
    assert feed(client)["ordering"] == ordering
    response = client.get("/app/api/posts/")
    assert response.status_code == 200
    assert response.json()["ordering"] == ordering
    assert response.headers["cache-control"] == "no-store"
    redirect = client.get("/app/api/posts/", follow_redirects=False)
    assert redirect.status_code == 307
    assert urlsplit(redirect.headers["location"]).path == urlsplit(timelines["app_url"]).path + "api/posts"


@pytest.mark.parametrize("damage", ["missing", "empty"])
def test_restart_recovers_checkpoint_when_live_database_is_lost(configuration, damage):
    with TestClient(create_app(**configuration)) as connection:
        parent_id = listing(connection)["active_timeline_id"]
        publish(connection, "Parent before branching")
        child = sprout(connection, modification="popular_feed")
        publish(connection, "Durable child data")
        expected = feed(connection)
        call(connection, "POST", f"/api/timelines/{child['id']}/snapshots", 201)
    database = configuration["state_dir"] / "workspace/state/app.sqlite3"
    if damage == "missing":
        database.unlink()
    else:
        database.write_bytes(b"")
    with TestClient(create_app(**configuration)) as connection:
        assert_preview(connection, child["id"], "popular")
        assert feed(connection) == expected
        activate(connection, parent_id)
        assert "Durable child data" not in {post["content"] for post in feed(connection)["posts"]}
        activate(connection, child["id"])
        assert feed(connection) == expected


def test_delayed_generation_preserves_new_active_sibling_and_frozen_parent(client, monkeypatch):
    root_id = listing(client)["active_timeline_id"]
    sibling = sprout(client)
    publish(client, "Sibling only")
    activate(client, root_id)
    publish(client, "Captured parent")
    entered, release = pause_adoption(client, monkeypatch)
    generation_id = generate(client, root_id)
    try:
        assert entered.wait(15)
        record = call(client, "GET", f"/api/generations/{generation_id}")
        snapshot = client.app.state.engine.storage.snapshots / record["base_snapshot_id"]
        immutable_base = digest(snapshot)
        publish(client, "Parent after capture")
        activate(client, sibling["id"])
        sibling_feed = feed(client)
    finally:
        release.set()
    result = finish(client, generation_id)
    assert result["status"] == "succeeded", result
    assert_preview(client, sibling["id"], "chronological")
    assert feed(client) == sibling_feed
    assert digest(snapshot) == immutable_base
    activate(client, result["timeline_id"])
    assert_preview(client, result["timeline_id"], "popular")
    assert "Captured parent" in {post["content"] for post in feed(client)["posts"]}
    assert not {"Parent after capture", "Sibling only"} & {post["content"] for post in feed(client)["posts"]}
    activate(client, root_id)
    assert "Parent after capture" in {post["content"] for post in feed(client)["posts"]}


def test_declining_parent_before_adoption_rejects_generated_future(client, monkeypatch):
    root_id = listing(client)["active_timeline_id"]
    parent = sprout(client)
    publish(client, "Archived parent data")
    entered, release = pause_adoption(client, monkeypatch)
    generation_id = generate(client, parent["id"], activate_on_success=True)
    try:
        assert entered.wait(15)
        call(client, "POST", f"/api/timelines/{parent['id']}/decline")
        original = feed(client)
    finally:
        release.set()
    result = finish(client, generation_id)
    assert result["status"] == "failed"
    assert result["error"]["stage"] == "adopt"
    assert result["timeline_id"] is None
    assert len(listing(client)["timelines"]) == 2
    assert_preview(client, root_id, "chronological")
    assert feed(client) == original
    assert client.get("/app/").status_code == 200


@pytest.mark.parametrize("activate_on_success", [False, True])
def test_cancel_after_validation_cannot_publish_code_or_state(client, monkeypatch, activate_on_success):
    root_id = listing(client)["active_timeline_id"]
    publish(client, "Must survive cancellation")
    original = feed(client)
    source = digest(ROOT / "demo_app")
    entered, release = pause_adoption(client, monkeypatch)
    generation_id = generate(client, root_id, activate_on_success=activate_on_success)
    try:
        assert entered.wait(15)
        result = call(client, "POST", f"/api/generations/{generation_id}/cancel")
        assert result["status"] == "cancelled"
        assert result["timeline_id"] is None
    finally:
        release.set()
    result = finish(client, generation_id)
    assert result["status"] == "cancelled"
    assert len(listing(client)["timelines"]) == 1
    assert_preview(client, root_id, "chronological")
    assert feed(client) == original
    assert digest(ROOT / "demo_app") == source
    assert client.app.state.engine.storage.setting("transition") is None
    assert client.post(f"/api/generations/{generation_id}/cancel").status_code == 409


def test_generated_future_lifecycle_restores_code_database_and_preview(configuration):
    with TestClient(create_app(**configuration), root_path="/fork") as connection:
        root_id = listing(connection)["active_timeline_id"]
        parent_feed = feed(connection)
        result = finish(connection, generate(connection, root_id))
        assert result["status"] == "succeeded", result
        child_id = result["timeline_id"]
        child = call(connection, "POST", f"/api/timelines/{child_id}/confirm")
        assert child["status"] == "confirmed" and not child["is_active"]
        assert_preview(connection, root_id, "chronological")
        activate(connection, child_id)
        post = publish(connection, "Child checkpoint")
        saved = feed(connection)
        snapshot = call(connection, "POST", f"/api/timelines/{child_id}/snapshots", 201)
        publish(connection, "Discarded after restore")
        call(connection, "POST", f"/app/api/posts/{post['id']}/like")
        activate(connection, root_id)
        assert feed(connection) == parent_feed
        restored = call(connection, "POST", f"/api/timelines/{child_id}/restore", json={"snapshot_id": snapshot["id"]})
        assert restored["is_active"] and restored["status"] == "confirmed"
        assert_preview(connection, child_id, "popular")
        assert feed(connection) == saved
        activate(connection, root_id)
        assert feed(connection) == parent_feed


def test_decline_active_descendant_skips_archived_ancestor(client):
    root_id = listing(client)["active_timeline_id"]
    root_feed = feed(client)
    parent = sprout(client)
    publish(client, "Parent private data")
    child = sprout(client)
    publish(client, "Descendant private data")
    call(client, "POST", f"/api/timelines/{parent['id']}/decline")
    assert_preview(client, child["id"], "chronological")
    call(client, "POST", f"/api/timelines/{child['id']}/decline")
    assert_preview(client, root_id, "chronological")
    assert feed(client) == root_feed
    for timeline_id in (parent["id"], child["id"]):
        assert client.post(f"/api/timelines/{timeline_id}/activate").status_code == 409


@pytest.mark.parametrize("prompt,stage", [
    ("break the app", "compile"), ("add a failing test", "tests"), ("delete a test", "guard"),
])
def test_failed_generation_from_inactive_parent_cannot_corrupt_active_preview(client, prompt, stage):
    root_id = listing(client)["active_timeline_id"]
    publish(client, "Parent private data")
    sibling = sprout(client, modification="popular_feed")
    publish(client, "Active sibling private data")
    original = feed(client)
    engine = client.app.state.engine
    source = digest(ROOT / "demo_app")
    parent_snapshot = engine.storage.snapshots / engine.storage.timeline(root_id)["snapshot_id"]
    immutable_parent = digest(parent_snapshot)
    result = finish(client, generate(client, root_id, prompt=prompt, activate_on_success=True))
    assert result["status"] == "failed" and result["error"]["stage"] == stage
    assert result["timeline_id"] is None
    assert len(listing(client)["timelines"]) == 2
    assert_preview(client, sibling["id"], "popular")
    assert feed(client) == original
    assert digest(parent_snapshot) == immutable_parent
    assert digest(ROOT / "demo_app") == source


def test_requested_auto_activation_preserves_outgoing_sibling_live_writes(client):
    root_id = listing(client)["active_timeline_id"]
    publish(client, "Parent snapshot data")
    sibling = sprout(client)
    publish(client, "Uncheckpointed sibling data")
    sibling_feed = feed(client)
    result = finish(client, generate(client, root_id, activate_on_success=True))
    assert result["status"] == "succeeded", result
    assert_preview(client, result["timeline_id"], "popular")
    contents = {post["content"] for post in feed(client)["posts"]}
    assert "Parent snapshot data" in contents
    assert "Uncheckpointed sibling data" not in contents
    activate(client, sibling["id"])
    assert feed(client) == sibling_feed
