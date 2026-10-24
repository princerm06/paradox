"""Opt-in four-minute, fully offline generation reliability rehearsal."""

import json
import os
import sqlite3
import time

import pytest

from conftest import REPO


@pytest.mark.skipif(os.environ.get("PARADOX_LONG_GENERATION_TEST") != "1",
                    reason="Set PARADOX_LONG_GENERATION_TEST=1 for the four-minute scripted rehearsal")
def test_long_generation_switch_confirm_cancel_and_restart(engine_factory, tmp_path, monkeypatch):
    monkeypatch.delenv("FACTORY_API_KEY", raising=False)
    recipe = json.loads((REPO / "tests/fixtures/scripted_agent/popular_feed.json").read_text())
    recipe["delay_s"] = 270
    recipes = tmp_path / "long-recipes"
    recipes.mkdir()
    (recipes / "popular.json").write_text(json.dumps(recipe))
    engine = engine_factory(env={"PARADOX_AGENT": "scripted", "PARADOX_SCRIPTED_RECIPES": str(recipes)})
    root = engine.root_id()
    engine.post("parent before long generation")
    original_code = (engine.workspace_code / "ranking.py").read_bytes()
    candidate = engine.sprout("Independent future to confirm")
    child = candidate["id"]
    engine.activate(root)
    before_ids = set(engine.timelines())
    generation = engine.call("POST", "/api/generations", expect=202, json={
        "parent_id": root, "prompt": "popular", "provider": "scripted",
    })
    generation_id = generation["id"]
    path = "/api/generations/" + generation_id
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        record = engine.call("GET", path)
        if record["status"] == "generating":
            break
        assert record["status"] in {"queued", "preparing"}, record
        time.sleep(0.05)
    assert record["status"] == "generating", record
    started = time.monotonic()

    engine.post("parent write during long generation")
    parent_feed = engine.feed()
    engine.activate(child)
    assert engine.feed()["ordering"] == "popular"
    assert "parent write during long generation" not in engine.contents()
    engine.post("independent child write during long generation")
    child_feed = engine.feed()
    assert engine.call("POST", f"/api/timelines/{child}/confirm")["status"] == "confirmed"
    engine.activate(root)
    assert engine.feed() == parent_feed
    assert (engine.workspace_code / "ranking.py").read_bytes() == original_code

    generation_root = engine.state_dir / "generations" / generation_id / "workspace"
    assert (generation_root / "code/demo_app/ranking.py").read_bytes() == original_code
    with sqlite3.connect(f"file:{generation_root / 'state/app.sqlite3'}?mode=ro", uri=True) as database:
        inherited = {row[0] for row in database.execute("SELECT content FROM posts")}
    assert "parent before long generation" in inherited
    assert "parent write during long generation" not in inherited
    assert "independent child write during long generation" not in inherited

    while time.monotonic() - started < 240:
        assert engine.call("GET", path)["status"] == "generating"
        assert set(engine.timelines()) == before_ids, "Long-running generation produced a ghost timeline"
        assert engine.active_id() == root
        assert engine.call("GET", "/api/health")["active_timeline_id"] == root
        assert engine.feed() == parent_feed
        time.sleep(min(5, max(0, 240 - (time.monotonic() - started))))

    engine.activate(child)
    assert engine.feed() == child_feed
    assert engine.call("GET", "/app/health")["ordering"] == "popular"
    assert engine.timelines()[child]["status"] == "confirmed"
    cancelled = engine.call("POST", path + "/cancel")
    assert cancelled["status"] == "cancelled" and cancelled["timeline_id"] is None
    time.sleep(0.5)
    assert engine.call("GET", path)["status"] == "cancelled"
    assert set(engine.timelines()) == before_ids
    assert engine.active_id() == child
    assert engine.feed() == child_feed

    engine.stop()
    engine.start()
    assert engine.call("GET", path)["status"] == "cancelled"
    assert engine.call("GET", path)["timeline_id"] is None
    assert set(engine.timelines()) == before_ids
    assert engine.active_id() == child
    assert engine.feed() == child_feed
    engine.activate(root)
    assert engine.feed() == parent_feed
    assert (engine.workspace_code / "ranking.py").read_bytes() == original_code
    engine.activate(child)
    assert engine.feed() == child_feed
