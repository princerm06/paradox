"""Fork milestone 2 acceptance tests: AI-generated futures and safe local development.

The spec is docs/contracts/m2-generation.md. Everything runs against a real engine
process over HTTP. The deterministic `scripted` provider stands in for Droid. The
recipes live in tests/fixtures/scripted_agent/ (owned by Codex 2).
"""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time

import httpx
import pytest

from conftest import DEMO_SOURCE, REPO, free_port, tree_digest

RECIPES = REPO / "tests" / "fixtures" / "scripted_agent"
TERMINAL = {"succeeded", "failed", "cancelled"}
CHECK_ORDER = ["agent", "guard", "compile", "tests", "boot", "smoke"]

# strict=True: once a part lands these XPASS and fail. That's the signal to remove the marker.
pending_m20 = pytest.mark.xfail(strict=True, reason="M2.0 safe local dev (CORS env, token, launcher) not implemented yet")
pending_gen = pytest.mark.xfail(strict=True, reason="M2 generation API not implemented yet")


@pytest.fixture
def gen(engine_factory):
    return engine_factory(env={"PARADOX_AGENT": "scripted", "PARADOX_SCRIPTED_RECIPES": str(RECIPES)})


def require_generation_api(e):
    # Precondition: without it a missing route's 404 could make negative tests pass by accident.
    agents = e.call("GET", "/api/agents")
    assert any(p["id"] == "scripted" and p["available"] for p in agents["providers"]), agents


def start(e, prompt, parent_id=None, expect=202, **extra):
    body = {"parent_id": parent_id or e.active_id(), "prompt": prompt, "provider": "scripted", **extra}
    return e.call("POST", "/api/generations", expect=expect, json=body)


def wait(e, gid, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        g = e.call("GET", f"/api/generations/{gid}")
        if g["status"] in TERMINAL:
            return g
        time.sleep(0.25)
    raise AssertionError(f"generation {gid} not terminal after {timeout}s: {g}\n{e.log_tail()}")


def root_ranking(e):
    return (e.workspace_code / "ranking.py").read_bytes()


# M2.0: safe local development ----------------------------------------------------------

@pending_m20
def test_cors_origins_are_configurable(engine_factory):
    e = engine_factory(env={"PARADOX_CORS_ORIGINS": "http://fork.example:4000"})

    def preflight(origin):
        return e.http.options("/api/timelines/sprout", headers={
            "Origin": origin, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,authorization"})

    ok = preflight("http://fork.example:4000")
    assert ok.status_code == 200
    assert ok.headers.get("access-control-allow-origin") == "http://fork.example:4000"
    assert "authorization" in ok.headers.get("access-control-allow-headers", "").lower()
    assert preflight("http://localhost:5173").headers.get("access-control-allow-origin") is None


@pending_m20
def test_token_required_for_mutating_api_calls_only(engine_factory):
    e = engine_factory(env={"PARADOX_TOKEN": "s3cret-token"})
    root = e.root_id()  # GET needs no token
    body = {"name": "x", "modification": "none"}
    assert e.http.post("/api/timelines/sprout", json=body).status_code == 401
    assert e.http.post("/api/timelines/sprout", json=body, headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert e.active_id() == root, "a rejected request must not change state"
    ok = e.http.post("/api/timelines/sprout", json=body, headers={"Authorization": "Bearer s3cret-token"})
    assert ok.status_code == 201, ok.text
    assert e.http.post("/app/api/posts", json={"author": "a", "content": "iframe traffic"}).status_code == 201


@pending_m20
def test_launcher_refuses_public_bind_without_token(tmp_path):
    env = {**os.environ, "PYTHONPATH": str(REPO), "PARADOX_STATE_DIR": str(tmp_path / "s")}
    env.pop("PARADOX_TOKEN", None)
    r = subprocess.run([sys.executable, "-m", "engine", "--host", "0.0.0.0", "--port", str(free_port())],
                       cwd=REPO, env=env, capture_output=True, text=True, timeout=30)
    assert r.returncode != 0
    assert "PARADOX_TOKEN" in (r.stdout + r.stderr)


# M2: AI-generated futures -----------------------------------------------------------------

@pending_gen
def test_ai_future_success_keeps_original_untouched(gen):
    require_generation_api(gen)
    source_before = tree_digest(DEMO_SOURCE)
    root = gen.root_id()
    gen.post("root: before generation")  # live, never checkpointed: generation must inherit it
    root_likes = gen.likes()
    root_code = root_ranking(gen)

    g = start(gen, "Rank the feed by popularity", name="Popularity (AI)")
    assert g["status"] == "queued" and g["timeline_id"] is None and g["parent_id"] == root
    g = wait(gen, g["id"])
    assert g["status"] == "succeeded", g
    assert g["error"] is None and g["finished_at"] and g["base_snapshot_id"]
    ev = g["evaluation"]
    assert ev["passed"] is True
    assert [c["name"] for c in ev["checks"]] == CHECK_ORDER
    assert all(c["status"] == "passed" for c in ev["checks"])
    assert ev["tests"]["passed"] >= 1 and ev["tests"]["failed"] == 0
    assert "demo_app/ranking.py" in [f["path"] for f in g["changes"]["files"]]
    diff = gen.http.get(f"/api/generations/{g['id']}/diff")
    assert diff.status_code == 200 and "ranking.py" in diff.text
    assert gen.call("GET", f"/api/generations/{g['id']}/logs", params={"stream": "validation"})["lines"]

    # The original never moved.
    assert gen.active_id() == root
    assert gen.feed()["ordering"] == "chronological"
    assert gen.likes() == root_likes
    assert root_ranking(gen) == root_code
    assert tree_digest(DEMO_SOURCE) == source_before

    # The new future is a normal pending timeline.
    child = gen.timelines()[g["timeline_id"]]
    assert child["parent_id"] == root and child["status"] == "pending"
    assert child["modification"] == "ai" and child["generation_id"] == g["id"]
    assert gen.timelines()[root]["generation_id"] is None

    gen.activate(child["id"])
    assert gen.feed()["ordering"] == "popular"
    assert gen.likes() == root_likes, "AI future must inherit the parent's live state, unmodified by validation"
    assert root_ranking(gen) != root_code
    gen.activate(root)
    assert gen.feed()["ordering"] == "chronological" and gen.likes() == root_likes
    assert gen.call("POST", f"/api/timelines/{child['id']}/confirm")["status"] == "confirmed"


@pending_gen
def test_generation_from_inactive_parent_uses_its_saved_state(gen):
    require_generation_api(gen)
    root = gen.root_id()
    side = gen.sprout("side", modification="none")
    gen.post("only in side")
    gen.activate(root)
    g = wait(gen, start(gen, "make it popular", parent_id=side["id"])["id"])
    assert g["status"] == "succeeded", g
    assert gen.active_id() == root
    gen.activate(g["timeline_id"])
    assert "only in side" in gen.contents() and gen.feed()["ordering"] == "popular"


@pending_gen
def test_activate_on_success(gen):
    require_generation_api(gen)
    g = wait(gen, start(gen, "popular please", activate_on_success=True)["id"])
    assert g["status"] == "succeeded", g
    assert gen.active_id() == g["timeline_id"]
    assert gen.feed()["ordering"] == "popular"


@pending_gen
@pytest.mark.parametrize("prompt,stage", [
    ("Please break the app", "compile"),
    ("Add a failing test", "tests"),
    ("Delete a test you dislike", "guard"),
    ("this matches no recipe at all", "agent"),
])
def test_failed_generation_creates_no_timeline_and_preserves_original(gen, prompt, stage):
    require_generation_api(gen)
    root = gen.root_id()
    gen.post("root data")
    before = (set(gen.timelines()), gen.likes(), root_ranking(gen))

    g = wait(gen, start(gen, prompt)["id"])
    assert g["status"] == "failed", g
    assert g["error"]["stage"] == stage and g["error"]["message"]
    assert g["timeline_id"] is None
    if g["evaluation"]:
        assert g["evaluation"]["passed"] is False
        assert g["evaluation"]["checks"][-1]["status"] == "failed"
    assert gen.call("GET", f"/api/generations/{g['id']}/logs")["stream"] == "agent"

    assert (set(gen.timelines()), gen.likes(), root_ranking(gen)) == before
    assert gen.active_id() == root and gen.feed()["ordering"] == "chronological"


@pending_gen
def test_user_keeps_working_while_generation_runs(gen):
    require_generation_api(gen)
    root = gen.root_id()
    g = start(gen, "slow but harmless change")
    child = gen.sprout("manual", modification="popular_feed")
    gen.post("written during generation")
    gen.activate(root)
    gen.post("root during generation")
    assert gen.call("GET", f"/api/generations/{g['id']}")["status"] not in TERMINAL, \
        "slow recipe finished before user actions; the test proves nothing"
    done = wait(gen, g["id"])
    assert done["status"] == "succeeded", done
    gen.activate(child["id"])
    assert "written during generation" in gen.contents()


@pending_gen
def test_cancel_generation(gen):
    require_generation_api(gen)
    before = set(gen.timelines())
    g = start(gen, "slow change to cancel")
    c = gen.call("POST", f"/api/generations/{g['id']}/cancel")
    assert c["status"] == "cancelled" and c["timeline_id"] is None
    assert gen.http.post(f"/api/generations/{g['id']}/cancel").status_code == 409
    time.sleep(6)  # longer than the slow recipe: it must not resurrect
    assert gen.call("GET", f"/api/generations/{g['id']}")["status"] == "cancelled"
    assert set(gen.timelines()) == before


@pending_gen
def test_engine_crash_mid_generation_marks_it_failed(engine_factory):
    env = {"PARADOX_AGENT": "scripted", "PARADOX_SCRIPTED_RECIPES": str(RECIPES)}
    first = engine_factory(env=env)
    require_generation_api(first)
    before = set(first.timelines())
    g = start(first, "slow change interrupted by a crash")
    time.sleep(1)
    first.stop(signal.SIGKILL)
    second = engine_factory(first.state_dir, env=env)
    after = second.call("GET", f"/api/generations/{g['id']}")
    assert after["status"] == "failed" and after["error"]["stage"] == "engine"
    assert set(second.timelines()) == before
    assert second.feed()["ordering"] == "chronological"


@pending_gen
def test_request_validation_errors(gen):
    require_generation_api(gen)
    assert gen.http.post("/api/generations", json={"parent_id": "nope", "prompt": "popular", "provider": "scripted"}).status_code == 404
    assert gen.http.post("/api/generations", json={"parent_id": gen.root_id(), "prompt": "", "provider": "scripted"}).status_code == 422
    assert gen.http.post("/api/generations", json={"parent_id": gen.root_id(), "prompt": "x", "provider": "nope"}).status_code == 422
    drop = gen.sprout("drop", modification="none")
    gen.call("POST", f"/api/timelines/{drop['id']}/decline")
    assert gen.http.post("/api/generations", json={"parent_id": drop["id"], "prompt": "popular", "provider": "scripted"}).status_code == 409
    assert gen.http.get("/api/generations/does-not-exist").status_code == 404
    listing = gen.call("GET", "/api/generations")
    assert listing["generations"] == []


@pending_gen
def test_unavailable_provider_is_rejected_up_front(gen):
    require_generation_api(gen)
    droid = next(p for p in gen.call("GET", "/api/agents")["providers"] if p["id"] == "droid")
    if droid["available"]:
        pytest.skip("droid is installed and authenticated here")
    assert droid["reason"]
    r = gen.http.post("/api/generations", json={"parent_id": gen.root_id(), "prompt": "popular", "provider": "droid"})
    assert r.status_code == 422 and "droid" in r.json()["detail"]
    assert gen.call("GET", "/api/generations")["generations"] == []


@pytest.mark.skipif(not (shutil.which("droid") and os.environ.get("FACTORY_API_KEY")),
                    reason="live Droid test needs the droid CLI and FACTORY_API_KEY")
def test_live_droid_generation_records_a_complete_result(engine_factory):
    e = engine_factory(env={"PARADOX_AGENT": "droid"})
    root = e.root_id()
    g = e.call("POST", "/api/generations", expect=202, json={
        "parent_id": root, "prompt": "Rank the feed by number of likes, most liked first. Add a test."})
    g = wait(e, g["id"], timeout=600)
    assert g["status"] in {"succeeded", "failed"}
    assert g["agent"] and g["agent"]["duration_ms"] >= 0
    assert e.active_id() == root and e.feed()["ordering"] == "chronological"
    if g["status"] == "succeeded":
        e.activate(g["timeline_id"])
        likes = [p["likes"] for p in e.feed()["posts"]]
        assert likes == sorted(likes, reverse=True)
