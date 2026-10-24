"""One paid SDK generation, exercised through a disposable real HTTP engine."""

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

import httpx

from engine.jobs import redact


PROMPT = "Rank the feed by popularity, most liked first. Add a test."
TERMINAL = {"succeeded", "failed", "cancelled"}


@contextmanager
def local_engine(state):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    launcher = (
        "import sys,uvicorn;from engine.api import create_app;"
        "uvicorn.run(create_app(state_dir=sys.argv[1],runtime_port=0),"
        "host='127.0.0.1',port=int(sys.argv[2]),log_level='warning')"
    )
    environment = os.environ.copy()
    environment["PARADOX_AGENT"] = "droid"
    with (state / "http-engine.log").open("wb") as output:
        process = subprocess.Popen([sys.executable, "-c", launcher, str(state), str(port)],
                                   env=environment, stdout=output, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            headers = {"authorization": "Bearer " + environment["PARADOX_TOKEN"]} if environment.get("PARADOX_TOKEN") else {}
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=30,
                              trust_env=False, headers=headers) as client:
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError("Engine exited; inspect http-engine.log")
                    try:
                        if client.get("/api/health").status_code == 200:
                            break
                    except httpx.HTTPError:
                        pass
                    time.sleep(.1)
                else:
                    raise RuntimeError("Engine startup timed out")
                yield client
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)


def request(client, method, path, **kwargs):
    response = client.request(method, path, **kwargs)
    response.raise_for_status()
    return response.json()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(client, state, evidence):
    evidence["agents"] = request(client, "GET", "/api/agents")
    droid = next(item for item in evidence["agents"]["providers"] if item["id"] == "droid")
    if not droid["available"]:
        raise RuntimeError("Droid unavailable: " + droid["reason"])
    listing = request(client, "GET", "/api/timelines")
    root = listing["active_timeline_id"]
    ranking = state / "workspace/code/demo_app/ranking.py"
    original_hash = digest(ranking)
    request(client, "POST", "/app/api/posts", json={"author": "verification", "content": "parent sentinel"})
    original_feed = request(client, "GET", "/app/api/posts")
    evidence["generation_post_attempts"] = 1
    response = client.post("/api/generations", json={"parent_id": root, "provider": "droid",
                           "prompt": PROMPT, "name": "Live official SDK proof", "activate_on_success": False})
    assert response.status_code == 202, response.status_code
    record = response.json()
    generation_id = record["id"]
    evidence.update(generation_id=generation_id, prompt=PROMPT, submitted=record,
                    observed_statuses=[record["status"]])
    deadline = time.monotonic() + 360
    while record["status"] not in TERMINAL:
        if time.monotonic() >= deadline:
            request(client, "POST", f"/api/generations/{generation_id}/cancel")
            raise RuntimeError("Live verification deadline exceeded; cancellation requested")
        time.sleep(.05)
        record = request(client, "GET", f"/api/generations/{generation_id}")
        if evidence["observed_statuses"][-1] != record["status"]:
            evidence["observed_statuses"].append(record["status"])
    evidence["generation"] = record
    for stream in ("agent", "validation"):
        evidence[stream + "_logs"] = request(client, "GET", f"/api/generations/{generation_id}/logs?stream={stream}&tail=2000")
    diff = client.get(f"/api/generations/{generation_id}/diff")
    diff.raise_for_status()
    (state / "http-diff.patch").write_text(redact(diff.text))
    evidence["timeline_listing"] = request(client, "GET", "/api/timelines")
    assert record["provider"] == "droid"
    assert record["agent"] and record["agent"]["session_id"]
    assert record["status"] == "succeeded", record.get("error")
    assert record["evaluation"]["passed"]
    assert all(check["status"] == "passed" for check in record["evaluation"]["checks"])
    changed = record["changes"]["files"]
    assert any(item["path"] == "demo_app/ranking.py" for item in changed)
    assert any(item["path"].startswith("demo_app/tests/") and item["status"] == "added" for item in changed)
    assert evidence["timeline_listing"]["active_timeline_id"] == root
    assert request(client, "GET", "/app/api/posts") == original_feed
    assert digest(ranking) == original_hash
    child = next(item for item in evidence["timeline_listing"]["timelines"] if item["id"] == record["timeline_id"])
    assert child["generation_id"] == generation_id and child["parent_id"] == root
    assert child["modification"] == "ai"
    child_source = state / "snapshots" / child["snapshot_id"] / "code/demo_app/ranking.py"
    child_hash = digest(child_source)
    assert child_hash != original_hash
    request(client, "POST", "/app/api/posts", json={"author": "verification", "content": "parent only"})
    request(client, "POST", f"/api/timelines/{child['id']}/activate")
    child_feed = request(client, "GET", "/app/api/posts")
    likes = [post["likes"] for post in child_feed["posts"]]
    assert likes == sorted(likes, reverse=True)
    assert "parent only" not in [post["content"] for post in child_feed["posts"]]
    assert digest(ranking) == child_hash
    child_post = request(client, "POST", "/app/api/posts", json={"author": "verification", "content": "child only"})
    request(client, "POST", f"/app/api/posts/{child_post['id']}/like")
    request(client, "POST", f"/api/timelines/{root}/activate")
    parent_feed = request(client, "GET", "/app/api/posts")
    contents = [post["content"] for post in parent_feed["posts"]]
    assert "parent only" in contents and "child only" not in contents
    assert parent_feed["ordering"] == "chronological" and digest(ranking) == original_hash
    request(client, "POST", f"/api/timelines/{child['id']}/activate")
    revisited = request(client, "GET", "/app/api/posts")
    assert next(post for post in revisited["posts"] if post["content"] == "child only")["likes"] == 1
    assert "parent only" not in [post["content"] for post in revisited["posts"]]
    assert digest(ranking) == child_hash
    evidence.update(parent_feed=parent_feed, child_feed=child_feed, revisited_child_feed=revisited,
                    source_hashes={"parent": original_hash, "child": child_hash},
                    verified=True, health=request(client, "GET", "/api/health"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, required=True,
                        help="New directory; refuses reuse to prevent accidental paid retries")
    args = parser.parse_args()
    state = args.state_dir.resolve()
    state.mkdir(parents=True, exist_ok=False)
    sdk_package = Path(__file__).with_name("node_modules") / "@factory/droid-sdk/package.json"
    evidence = {"verified": False, "sdk_version": json.loads(sdk_package.read_text())["version"] if sdk_package.exists() else None,
                "generation_post_attempts": 0}
    try:
        with local_engine(state) as client:
            verify(client, state, evidence)
    except Exception as error:
        evidence["verification_error"] = redact(str(error))
    finally:
        (state / "http-evidence.json").write_text(redact(json.dumps(evidence, indent=2)) + "\n")
    print(json.dumps({"verified": evidence["verified"], "generation_id": evidence.get("generation_id"),
                      "status": evidence.get("generation", {}).get("status"),
                      "evidence": str(state / "http-evidence.json"),
                      "error": evidence.get("verification_error")}))
    return 0 if evidence["verified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
