import json
from pathlib import Path
import socket
import sqlite3

from fastapi.testclient import TestClient
import pytest

from engine.api import create_app
from engine.storage import Storage
from engine.templates.popular_ranking import rank


SOURCE = Path(__file__).parent / "fixtures" / "engine_demo"


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(state_dir=tmp_path, runtime_port=0, runtime_source=SOURCE)) as connection:
        yield connection


def sprout(client, **body):
    response = client.post("/api/timelines/sprout", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def activate(client, timeline_id):
    response = client.post(f"/api/timelines/{timeline_id}/activate")
    assert response.status_code == 200, response.text
    return response.json()


def feed(client):
    response = client.get("/app/api/posts")
    assert response.status_code == 200, response.text
    return response.json()


def publish(client, content):
    response = client.post("/app/api/posts", json={"content": content})
    assert response.status_code == 201, response.text


def test_health_reads_storage_under_engine_gate(client, monkeypatch):
    engine = client.app.state.engine
    original = engine.storage.setting

    def checked_setting(key):
        assert engine.gate.lock._is_owned()
        return original(key)

    monkeypatch.setattr(engine.storage, "setting", checked_setting)
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["runtime_running"] is True


def test_popular_sprout_changes_only_working_code_and_restores_it(client):
    engine = client.app.state.engine
    original = (SOURCE / "ranking.py").read_bytes()
    root = client.get("/api/timelines").json()["timelines"][0]
    assert root["modification"] is None
    assert [post["id"] for post in feed(client)["posts"]] == [2, 1]
    child = sprout(client, name="Popularity")
    assert child["modification"] == "popular_feed"
    code = engine.storage.workspace / "code" / "demo_app" / "ranking.py"
    assert code.read_bytes() != original
    assert code.read_bytes() == (Path(__file__).parents[1] / "engine/templates/popular_ranking.py").read_bytes()
    assert (SOURCE / "ranking.py").read_bytes() == original
    assert feed(client)["ordering"] == "popular"
    assert [post["id"] for post in feed(client)["posts"]] == [1, 2]
    activate(client, root["id"])
    assert code.read_bytes() == original
    assert feed(client)["ordering"] == "chronological"
    activate(client, child["id"])
    assert feed(client)["ordering"] == "popular"


def test_inactive_parent_uses_its_snapshot_not_active_workspace(client):
    root_id = client.get("/api/timelines").json()["active_timeline_id"]
    publish(client, "parent data")
    child = sprout(client)
    publish(client, "active child only")
    code = client.app.state.engine.storage.workspace / "code" / "demo_app"
    (code / "child_only.txt").write_text("must not leak")
    sibling = sprout(client, parent_id=root_id, modification="none")
    assert sibling["parent_id"] == root_id
    assert sibling["modification"] == "none"
    assert feed(client)["ordering"] == "chronological"
    assert "parent data" in {post["content"] for post in feed(client)["posts"]}
    assert "active child only" not in {post["content"] for post in feed(client)["posts"]}
    assert not (code / "child_only.txt").exists()
    activate(client, child["id"])
    assert "active child only" in {post["content"] for post in feed(client)["posts"]}
    assert (code / "child_only.txt").read_text() == "must not leak"
    grandchild = sprout(client, parent_id=child["id"], modification="none")
    assert grandchild["parent_id"] == child["id"]
    assert "active child only" in {post["content"] for post in feed(client)["posts"]}


def test_invalid_parent_does_not_interrupt_active_state(client):
    root_id = client.get("/api/timelines").json()["active_timeline_id"]
    process_id = client.app.state.engine.runtime.process.pid
    assert client.post("/api/timelines/sprout", json={"parent_id": "missing"}).status_code == 404
    assert client.post("/api/timelines/sprout", json={"parent_id": ""}).status_code == 422
    assert client.app.state.engine.runtime.process.pid == process_id
    declined = sprout(client)
    assert client.post(f"/api/timelines/{declined['id']}/decline").status_code == 200
    assert client.post("/api/timelines/sprout", json={"parent_id": declined["id"]}).status_code == 409
    assert client.get("/api/timelines").json()["active_timeline_id"] == root_id


def test_failed_inactive_parent_sprout_rolls_back_live_child(client, monkeypatch):
    engine = client.app.state.engine
    root_id = engine.active_id
    child = sprout(client)
    publish(client, "uncheckpointed data")
    original_start = engine.runtime.start
    attempts = []

    def fail_once():
        attempts.append(True)
        if len(attempts) == 1:
            raise RuntimeError("injected startup failure")
        original_start()

    monkeypatch.setattr(engine.runtime, "start", fail_once)
    response = client.post("/api/timelines/sprout", json={"parent_id": root_id})
    assert response.status_code == 503
    assert engine.active_id == child["id"]
    assert feed(client)["ordering"] == "popular"
    assert "uncheckpointed data" in {post["content"] for post in feed(client)["posts"]}
    assert len(client.get("/api/timelines").json()["timelines"]) == 2
    assert engine.storage.setting("transition") is None


def test_failed_inactive_restore_does_not_move_target_head(client, monkeypatch):
    engine = client.app.state.engine
    root_id = engine.active_id
    child = sprout(client)
    publish(client, "new child data")
    activate(client, root_id)
    original_head = engine.storage.timeline(child["id"])["snapshot_id"]
    original_start = engine.runtime.start
    attempts = []

    def fail_second_start():
        attempts.append(True)
        if len(attempts) == 2:
            raise RuntimeError("injected failure after restore snapshot")
        original_start()

    monkeypatch.setattr(engine.runtime, "start", fail_second_start)
    response = client.post(f"/api/timelines/{child['id']}/restore", json={"snapshot_id": child["snapshot_id"]})
    assert response.status_code == 503
    assert engine.active_id == root_id
    assert engine.storage.timeline(child["id"])["snapshot_id"] == original_head
    activate(client, child["id"])
    assert "new child data" in {post["content"] for post in feed(client)["posts"]}


def test_repeated_switches_rebind_same_port_and_preserve_one_runtime(client):
    engine = client.app.state.engine
    root_id = engine.active_id
    child = sprout(client)
    port = engine.runtime.port
    for iteration in range(8):
        target = root_id if iteration % 2 == 0 else child["id"]
        previous_process = engine.runtime.process
        activate(client, target)
        assert previous_process.poll() is not None
        assert engine.runtime.running
        assert engine.runtime.port == port
        assert feed(client)["ordering"] == ("chronological" if target == root_id else "popular")
        with socket.socket() as contender:
            with pytest.raises(OSError):
                contender.bind(("127.0.0.1", port))


def test_default_app_url_uses_request_origin(client):
    response = client.get("/api/timelines", headers={"host": "engine.fork.test:9000"})
    assert response.json()["app_url"] == "http://engine.fork.test:9000/app/"


def test_openapi_exposes_finalized_sprout_and_timeline_schemas(client):
    schemas = client.get("/openapi.json").json()["components"]["schemas"]
    assert "parent_id" in schemas["SproutRequest"]["properties"]
    assert "modification" in schemas["Timeline"]["properties"]
    assert "app_url" in schemas["TimelineList"]["properties"]


def test_default_app_url_includes_deployment_root_path(tmp_path):
    application = create_app(state_dir=tmp_path, runtime_port=0, runtime_source=SOURCE)
    with TestClient(application, root_path="/engine") as connection:
        assert connection.get("/api/timelines").json()["app_url"] == "http://testserver/engine/app/"
        response = connection.get("/app/redirect-target", follow_redirects=False)
        assert response.headers["location"] == "/engine/app/redirect-target/"


@pytest.mark.parametrize("via_environment", [False, True])
def test_configurable_absolute_app_url(tmp_path, monkeypatch, via_environment):
    kwargs = {}
    if via_environment:
        monkeypatch.setenv("PARADOX_APP_URL", "https://fork.example/tools/app")
    else:
        monkeypatch.setenv("PARADOX_APP_URL", "https://ignored.example/app/")
        kwargs["app_url"] = "https://fork.example/tools/app"
    with TestClient(create_app(state_dir=tmp_path, runtime_port=0, runtime_source=SOURCE, **kwargs)) as connection:
        assert connection.get("/api/timelines").json()["app_url"] == "https://fork.example/tools/app/"
        response = connection.get("/app/redirect-target", follow_redirects=False)
        assert response.headers["location"] == "/tools/app/redirect-target/"


@pytest.mark.parametrize("value", ["/app/", "file:///app", "https://fork.example/app?q=1", "https://user:pass@fork.example/app"])
def test_app_url_rejects_invalid_configuration(value):
    with pytest.raises(ValueError, match="absolute HTTP"):
        create_app(app_url=value)


def test_modification_migrates_legacy_database(tmp_path):
    with sqlite3.connect(tmp_path / "engine.sqlite3") as connection:
        connection.execute("CREATE TABLE timelines (id TEXT PRIMARY KEY,parent_id TEXT,name TEXT,status TEXT,created_at TEXT,snapshot_id TEXT)")
        connection.execute("INSERT INTO timelines VALUES ('root',NULL,'Original','confirmed','2026-01-01',NULL)")
    storage = Storage(tmp_path)
    try:
        assert storage.timeline("root")["modification"] is None
        child_id = storage.create_timeline("child", "root", modification="popular_feed")
        assert storage.timeline(child_id)["modification"] == "popular_feed"
    finally:
        storage.connection.close()


def test_modification_metadata_survives_restart(tmp_path):
    kwargs = {"state_dir": tmp_path, "runtime_port": 0, "runtime_source": SOURCE}
    with TestClient(create_app(**kwargs)) as connection:
        child = sprout(connection)
    with TestClient(create_app(**kwargs)) as connection:
        timelines = connection.get("/api/timelines").json()["timelines"]
        assert next(item for item in timelines if item["id"] == child["id"])["modification"] == "popular_feed"
        assert feed(connection)["ordering"] == "popular"


def test_popularity_template_ties_and_input_immutability():
    posts = [
        {"id": 1, "created_at": "2026-01-01", "likes": 2},
        {"id": 2, "created_at": "2026-01-02", "likes": 2},
        {"id": 3, "created_at": "2026-01-02", "likes": 2},
    ]
    original = json.dumps(posts)
    assert [post["id"] for post in rank(posts)] == [3, 2, 1]
    assert json.dumps(posts) == original
