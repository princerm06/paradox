"""Fork milestone-1 acceptance tests.

They drive a real engine process over HTTP, the same way the frontend will.
Every assertion is about behaviour a user could see in the demo.
"""
from __future__ import annotations

import os
import signal
import time

import httpx
import pytest

from conftest import DEMO_SOURCE, tree_digest

# Changes A–D were approved on 2026-10-23 and are implemented by Codex 1/2.
# strict=True: once a change lands these XPASS and fail. That's the signal to remove the marker.
pending_A = pytest.mark.xfail(strict=True, reason="Change A: popular_feed must be a code change via demo_app/ranking.py")
pending_B = pytest.mark.xfail(strict=True, reason="Change B: sprout accepts optional parent_id")
pending_C = pytest.mark.xfail(strict=True, reason="Change C: Timeline exposes `modification`")
pending_D = pytest.mark.xfail(strict=True, reason="Change D: app_url is absolute")


# 1–6: the hackathon demo, end to end -------------------------------------------------

def test_milestone_traversal(fork):
    # 1. Open the original application.
    root = fork.root_id()
    assert fork.timelines()[root]["status"] == "confirmed"
    assert fork.active_id() == root
    page = fork.http.get("/app/")
    assert page.status_code == 200 and "<html" in page.text.lower()
    assert fork.feed()["ordering"] == "chronological"
    seed = fork.contents()
    assert len(seed) >= 2

    # Interact in the original before forking: this write must be inherited.
    fork.post("root: before fork")
    root_like_target = fork.feed()["posts"][-1]
    fork.like(root_like_target["id"])
    root_likes_at_fork = fork.likes()

    # 2+3. Sprout a child with the deterministic modification.
    child = fork.sprout("Popular feed")
    assert child["parent_id"] == root and child["status"] == "pending" and child["is_active"] is True
    assert fork.active_id() == child["id"]
    child_feed = fork.feed()
    assert child_feed["ordering"] == "popular"
    likes = [p["likes"] for p in child_feed["posts"]]
    assert likes == sorted(likes, reverse=True), "child feed is not popularity-ranked"
    assert fork.likes() == root_likes_at_fork, "child did not inherit parent's live state"

    # 4. Interact with the modified application.
    fork.post("child: only in the future")
    cid = fork.post_id("child: only in the future")
    for _ in range(20):
        fork.like(cid)
    assert fork.contents()[0] == "child: only in the future", "popularity ranking did not apply to new data"
    child_state = fork.likes()

    # 5. Return to the original: behaviour and data intact, none of the child's changes.
    fork.activate(root)
    assert fork.feed()["ordering"] == "chronological"
    assert "child: only in the future" not in fork.contents()
    assert fork.likes() == root_likes_at_fork
    fork.post("root: after fork")
    root_state = fork.likes()

    # 6. Revisit the child: code, behaviour and data preserved, none of the root's later changes.
    fork.activate(child["id"])
    assert fork.feed()["ordering"] == "popular"
    assert fork.likes() == child_state
    assert "root: after fork" not in fork.contents()

    # ...and the root is still exactly as we left it.
    fork.activate(root)
    assert fork.likes() == root_state
    assert fork.feed()["ordering"] == "chronological"


# Isolation ----------------------------------------------------------------------------

def test_sibling_timelines_do_not_contaminate_each_other(fork):
    root = fork.root_id()
    a = fork.sprout("A")
    fork.post("only in A")

    fork.activate(root)
    b = fork.sprout("B")
    assert "only in A" not in fork.contents()
    fork.post("only in B")

    fork.activate(a["id"])
    assert "only in A" in fork.contents() and "only in B" not in fork.contents()
    fork.activate(root)
    assert not {"only in A", "only in B"} & set(fork.contents())
    fork.activate(b["id"])
    assert "only in B" in fork.contents() and "only in A" not in fork.contents()


def test_grandchild_inherits_chain_and_stays_isolated(fork):
    root = fork.root_id()
    child = fork.sprout("child")
    fork.post("child write")
    grandchild = fork.sprout("grandchild", modification="none")
    assert grandchild["parent_id"] == child["id"]
    assert "child write" in fork.contents()
    fork.post("grandchild write")

    fork.activate(child["id"])
    assert "grandchild write" not in fork.contents()
    fork.activate(root)
    assert not {"child write", "grandchild write"} & set(fork.contents())


def test_source_demo_app_is_never_modified(fork):
    before = tree_digest(DEMO_SOURCE)
    root = fork.root_id()
    fork.sprout("x")
    fork.post("x")
    fork.activate(root)
    fork.sprout("y", modification="none")
    fork.activate(root)
    assert tree_digest(DEMO_SOURCE) == before


# Runtime restart, rapid switching, and recovery ---------------------------------------

def test_switch_restarts_runtime_and_reactivate_is_noop(fork):
    root = fork.root_id()
    root_pid = fork.app_pid()
    fork.activate(root)
    assert fork.app_pid() == root_pid, "activating the active timeline must not restart"
    child = fork.sprout("child")
    child_pid = fork.app_pid()
    assert child_pid != root_pid
    fork.activate(root)
    assert fork.app_pid() not in (root_pid, child_pid)
    assert child["id"] != root


def test_rapid_switching_stays_correct(fork):
    root = fork.root_id()
    child = fork.sprout("child")
    fork.post("child marker")
    for i in range(10):
        fork.activate(root)
        f = fork.feed()
        assert f["ordering"] == "chronological", f"iteration {i}"
        assert "child marker" not in [p["content"] for p in f["posts"]]
        fork.activate(child["id"])
        f = fork.feed()
        assert f["ordering"] == "popular", f"iteration {i}"
        assert "child marker" in [p["content"] for p in f["posts"]]


def test_app_crash_preserves_live_state_and_recovers_on_activate(fork):
    child = fork.sprout("child")
    fork.post("written before crash")
    os.kill(fork.app_pid(), signal.SIGKILL)

    deadline = time.monotonic() + 5
    while fork.call("GET", "/api/health")["runtime_running"] and time.monotonic() < deadline:
        time.sleep(0.05)
    assert fork.call("GET", "/api/health")["runtime_running"] is False

    fork.activate(child["id"])
    assert fork.call("GET", "/api/health")["runtime_running"] is True
    assert "written before crash" in fork.contents()
    assert fork.feed()["ordering"] == "popular"


def test_engine_hard_kill_and_restart_preserves_all_timelines(engine_factory, tmp_path):
    first = engine_factory()
    root = first.root_id()
    first.post("root write")
    child = first.sprout("child")
    first.post("child live write")  # never explicitly checkpointed
    first.stop(signal.SIGKILL)

    second = engine_factory(first.state_dir)
    assert second.active_id() == child["id"]
    assert set(second.timelines()) == {root, child["id"]}
    assert "child live write" in second.contents()
    assert second.feed()["ordering"] == "popular"
    second.activate(root)
    assert "root write" in second.contents() and "child live write" not in second.contents()


def test_engine_graceful_restart_preserves_state(engine_factory):
    first = engine_factory()
    child = first.sprout("child")
    first.post("before graceful stop")
    first.stop()
    second = engine_factory(first.state_dir)
    assert second.active_id() == child["id"]
    assert "before graceful stop" in second.contents()


# Snapshots ----------------------------------------------------------------------------

def test_checkpoint_and_restore_rolls_back_data(fork):
    child = fork.sprout("child")
    fork.post("kept")
    snap = fork.call("POST", f"/api/timelines/{child['id']}/snapshots", expect=201)
    fork.post("rolled back")
    fork.call("POST", f"/api/timelines/{child['id']}/restore", json={"snapshot_id": snap["id"]})
    assert fork.active_id() == child["id"]
    assert "kept" in fork.contents() and "rolled back" not in fork.contents()
    assert fork.feed()["ordering"] == "popular"
    snaps = fork.call("GET", f"/api/timelines/{child['id']}/snapshots")["snapshots"]
    assert snap["id"] in [s["id"] for s in snaps]


def test_restore_rejects_snapshot_from_another_timeline(fork):
    root = fork.root_id()
    root_snap = fork.call("POST", f"/api/timelines/{root}/snapshots", expect=201)
    child = fork.sprout("child")
    r = fork.http.post(f"/api/timelines/{child['id']}/restore", json={"snapshot_id": root_snap["id"]})
    assert r.status_code == 404
    assert fork.active_id() == child["id"] and fork.feed()["ordering"] == "popular"


# Confirm / decline --------------------------------------------------------------------

def test_confirm_and_decline_lifecycle(fork):
    root = fork.root_id()
    assert fork.http.post(f"/api/timelines/{root}/decline").status_code == 409

    keep = fork.sprout("keep")
    assert fork.call("POST", f"/api/timelines/{keep['id']}/confirm")["status"] == "confirmed"
    assert fork.call("POST", f"/api/timelines/{keep['id']}/confirm")["status"] == "confirmed"  # idempotent
    assert fork.http.post(f"/api/timelines/{keep['id']}/decline").status_code == 409

    fork.post("in rejected future")
    drop = fork.sprout("drop", modification="none")
    fork.call("POST", f"/api/timelines/{drop['id']}/decline")
    assert fork.timelines()[drop["id"]]["status"] == "declined"
    assert fork.active_id() == keep["id"], "declining the active future must return to its parent"
    assert fork.http.post(f"/api/timelines/{drop['id']}/activate").status_code == 409
    assert "in rejected future" in fork.contents()


def test_unknown_timeline_is_404(fork):
    assert fork.http.post("/api/timelines/does-not-exist/activate").status_code == 404


# Frontend connectivity ----------------------------------------------------------------

def test_listing_shape_and_graph_integrity(fork):
    root = fork.root_id()
    c1 = fork.sprout("c1")
    fork.activate(root)
    fork.sprout("c2")
    listing = fork.listing()
    assert {"timelines", "active_timeline_id", "app_url"} <= set(listing)
    ids = {t["id"] for t in listing["timelines"]}
    for t in listing["timelines"]:
        assert {"id", "parent_id", "name", "status", "created_at", "snapshot_id", "is_active"} <= set(t)
        assert t["parent_id"] is None or t["parent_id"] in ids
    assert [t["id"] for t in listing["timelines"] if t["is_active"]] == [listing["active_timeline_id"]]
    assert c1["id"] in ids


@pytest.mark.parametrize("port", [3000, 5173])
def test_cors_allows_frontend_dev_ports(fork, port):
    origin = f"http://localhost:{port}"
    r = fork.http.options("/api/timelines/sprout", headers={
        "Origin": origin, "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type"})
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") == origin


def test_embedded_app_uses_relative_urls_through_proxy(fork):
    html = fork.http.get("/app/").text
    assert "fetch('/" not in html and 'fetch("/' not in html and "fetch(`/" not in html
    assert fork.http.get("/app/api/health").status_code == 200


# Approved changes A–D (expected failures until the Codex branches land) -------------------

@pending_A
def test_A_modification_is_a_code_change_not_config(fork):
    root = fork.root_id()
    source = (DEMO_SOURCE / "ranking.py").read_text()
    assert "chronological" in source
    root_code = (fork.workspace_code / "ranking.py").read_text()
    root_behavior = (fork.workspace_state / "behavior.json").read_bytes()

    child = fork.sprout("Popular feed")
    child_code = (fork.workspace_code / "ranking.py").read_text()
    assert child_code != root_code, "sprout must rewrite ranking.py in the child's code"
    assert (fork.workspace_state / "behavior.json").read_bytes() == root_behavior, \
        "the ordering change must come from code, not behavior.json"
    assert fork.feed()["ordering"] == "popular"

    fork.activate(root)
    assert (fork.workspace_code / "ranking.py").read_text() == root_code
    assert fork.feed()["ordering"] == "chronological"
    fork.activate(child["id"])
    assert (fork.workspace_code / "ranking.py").read_text() == child_code
    assert (DEMO_SOURCE / "ranking.py").read_text() == source


@pending_B
def test_B_sprout_from_non_active_parent(fork):
    root = fork.root_id()
    fork.sprout("child")
    fork.post("child only")
    sibling = fork.sprout("sibling", parent_id=root)
    assert sibling["parent_id"] == root
    assert fork.active_id() == sibling["id"]
    assert "child only" not in fork.contents()


@pending_C
def test_C_timeline_exposes_modification(fork):
    root = fork.root_id()
    assert fork.timelines()[root]["modification"] is None
    child = fork.sprout("Popular feed")
    assert child["modification"] == "popular_feed"
    plain = fork.sprout("plain", modification="none")
    assert plain["modification"] in (None, "none")


@pending_D
def test_D_app_url_is_absolute_and_serves_the_app(fork):
    url = fork.listing()["app_url"]
    assert url.startswith("http://") or url.startswith("https://")
    with httpx.Client(trust_env=False) as c:
        assert c.get(url).status_code == 200
