"""Exercise a disposable scripted Fork demo over real loopback HTTP."""

import argparse
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time

import httpx


ROOT = Path(__file__).resolve().parents[1]
TERMINAL = {"succeeded", "failed", "cancelled"}
LAUNCHER = (
    "import os, sys, threading, uvicorn; from engine.api import create_app; "
    "threading.Thread(target=lambda: (sys.stdin.buffer.read(), os._exit(1)), daemon=True).start(); "
    "uvicorn.run(create_app(runtime_port=0), fd=int(sys.argv[1]), log_level='warning')"
)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def passed(message):
    print("PASS: " + message, flush=True)


def request(client, method, path, expected=200, **kwargs):
    response = client.request(method, path, **kwargs)
    require(response.status_code == expected,
            f"{method} {path}: expected {expected}, got {response.status_code}: {response.text}")
    return response


def generation(client, parent, prompt):
    return request(client, "POST", "/api/generations", expected=202, json={
        "parent_id": parent, "prompt": prompt, "provider": "scripted",
    }).json()["id"]


def wait_generation(client, generation_id, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = request(client, "GET", "/api/generations/" + generation_id).json()
        if result["status"] in TERMINAL:
            return result
        time.sleep(0.05)
    raise RuntimeError(f"Generation did not finish: {result}")


def timelines(client):
    return request(client, "GET", "/api/timelines").json()


def feed(client):
    return request(client, "GET", "/app/api/posts").json()


def activate(client, timeline_id, ordering):
    result = request(client, "POST", f"/api/timelines/{timeline_id}/activate").json()
    require(result["is_active"], "Activation did not mark timeline active")
    require(timelines(client)["active_timeline_id"] == timeline_id, "Active timeline mismatch")
    require(request(client, "GET", "/api/health").json()["active_timeline_id"] == timeline_id,
            "Engine health routes to a different timeline")
    require(request(client, "GET", "/app/health").json()["ordering"] == ordering,
            "Application preview did not switch ranking")
    require(feed(client)["ordering"] == ordering, "Feed and preview disagree")


def rehearse(client):
    root = timelines(client)["active_timeline_id"]
    require(request(client, "GET", "/app/").headers["content-type"].startswith("text/html"),
            "Application viewport is not HTML")
    require(feed(client)["ordering"] == "chronological", "Fresh root is not chronological")
    favorite = request(client, "POST", "/app/api/posts", expected=201, json={
        "author": "Community", "content": "The community favorite: older, with twelve likes.",
    }).json()
    for unused in range(12):
        request(client, "POST", f"/app/api/posts/{favorite['id']}/like")
    newest = request(client, "POST", "/app/api/posts", expected=201, json={
        "author": "Newsroom", "content": "Breaking update: newest, but not yet popular.",
    }).json()
    root_feed = feed(client)
    require(root_feed["posts"][0]["id"] == newest["id"], "Newest post must lead root feed")
    passed("root viewport and seeded chronological feed")

    popular_id = generation(client, root, "Make the feed popular")
    popular = wait_generation(client, popular_id)
    require(popular["status"] == "succeeded", f"Popular generation failed: {popular}")
    require(popular["evaluation"]["passed"], "Popular validation did not pass")
    child = popular["timeline_id"]
    require(timelines(client)["active_timeline_id"] == root, "Generation switched active timeline")
    require(feed(client) == root_feed, "Generation changed parent database or behavior")
    activate(client, child, "popular")
    require(feed(client)["posts"][0]["id"] == favorite["id"], "Most-liked post must lead child feed")
    passed("scripted popular future changes implementation without changing root")

    marker = request(client, "POST", "/app/api/posts", expected=201, json={
        "author": "Explorer", "content": "This post exists only in the popular future.",
    }).json()
    child_feed = feed(client)
    activate(client, root, "chronological")
    require(feed(client) == root_feed, "Child write leaked into root")
    activate(client, child, "popular")
    require(feed(client) == child_feed, "Child write was lost after switching")
    require(any(post == marker for post in feed(client)["posts"]), "Child marker missing")
    diff = request(client, "GET", f"/api/generations/{popular_id}/diff").text
    require("demo_app/ranking.py" in diff, "Diff does not contain ranking source replacement")
    confirmed = request(client, "POST", f"/api/timelines/{child}/confirm").json()
    require(confirmed["status"] == "confirmed", "Future was not confirmed")
    passed("parent/child isolation, revisiting, source diff, and confirmation")

    activate(client, root, "chronological")
    alternative = wait_generation(client, generation(client, root, "Another popular future"))
    require(alternative["status"] == "succeeded", f"Second generation failed: {alternative}")
    declined = request(client, "POST", f"/api/timelines/{alternative['timeline_id']}/decline").json()
    require(declined["status"] == "declined", "Second future was not declined")
    require(timelines(client)["active_timeline_id"] == root, "Declining inactive future switched root")
    passed("separate future can be declined without affecting active root")

    before = {item["id"] for item in timelines(client)["timelines"]}
    broken = wait_generation(client, generation(client, root, "break the app"))
    require(broken["status"] == "failed" and broken["error"]["stage"] == "compile",
            f"Broken recipe did not fail compilation: {broken}")
    require(broken["timeline_id"] is None, "Failed generation created a timeline")
    require({item["id"] for item in timelines(client)["timelines"]} == before,
            "Failed generation left a ghost timeline")
    require(feed(client) == root_feed, "Failed generation corrupted parent")
    passed("broken recipe fails at compile with no timeline or parent corruption")

    slow_id = generation(client, root, "slow")
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        slow = request(client, "GET", f"/api/generations/{slow_id}").json()
        if slow["status"] == "generating":
            break
        require(slow["status"] not in TERMINAL, f"Slow recipe finished before cancellation: {slow}")
        time.sleep(0.05)
    require(slow["status"] == "generating", "Slow generation never entered agent stage")
    request(client, "POST", f"/api/generations/{slow_id}/cancel")
    cancelled = wait_generation(client, slow_id)
    require(cancelled["status"] == "cancelled" and cancelled["timeline_id"] is None,
            f"Slow recipe was not safely cancelled: {cancelled}")
    time.sleep(0.2)
    require({item["id"] for item in timelines(client)["timelines"]} == before,
            "Cancelled generation left a ghost timeline")
    require(feed(client) == root_feed, "Cancellation corrupted parent")
    activate(client, child, "popular")
    require(feed(client) == child_feed, "Failures corrupted previously confirmed child")
    passed("in-flight slow generation cancelled; confirmed future remains intact")


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    if process.stdin:
        process.stdin.close()


def interrupt(signum, frame):
    raise KeyboardInterrupt


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep-running", action="store_true",
                        help="Keep the successful demo available until Ctrl-C; then clean up")
    arguments = parser.parse_args(argv)
    previous_handler = signal.signal(signal.SIGTERM, interrupt)
    try:
        with tempfile.TemporaryDirectory(prefix="fork-rehearsal-") as temporary:
            directory = Path(temporary)
            log_path = directory / "engine.log"
            environment = {key: os.environ[key] for key in ("PATH", "HOME") if key in os.environ}
            environment.update(PARADOX_AGENT="scripted", PYTHONDONTWRITEBYTECODE="1",
                               PARADOX_STATE_DIR=str(directory / "state"),
                               PARADOX_SOURCE_DIR=str(ROOT / "demo_app"),
                               PARADOX_SCRIPTED_RECIPES=str(ROOT / "tests/fixtures/scripted_agent"))
            with socket.socket() as listener, log_path.open("wb") as log:
                listener.bind(("127.0.0.1", 0))
                listener.listen(128)
                url = f"http://127.0.0.1:{listener.getsockname()[1]}"
                process = subprocess.Popen([sys.executable, "-c", LAUNCHER, str(listener.fileno())],
                                           cwd=ROOT, env=environment, pass_fds=(listener.fileno(),),
                                           stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT)
                listener.close()
                print(f"Engine PID: {process.pid}\nState directory: {directory / 'state'}\nApp URL: {url}/app/", flush=True)
                try:
                    with httpx.Client(base_url=url, timeout=30, trust_env=False) as client:
                        deadline = time.monotonic() + 30
                        while time.monotonic() < deadline:
                            require(process.poll() is None, "Engine exited during startup")
                            try:
                                if client.get("/api/health").status_code == 200:
                                    break
                            except httpx.HTTPError:
                                pass
                            time.sleep(0.05)
                        else:
                            raise RuntimeError("Engine readiness timed out")
                        rehearse(client)
                        print("PASS: all scripted demo checks completed", flush=True)
                        if arguments.keep_running:
                            print("Demo ready. Engine stays available until Ctrl-C; cleanup follows.", flush=True)
                            try:
                                while process.poll() is None:
                                    time.sleep(0.5)
                            except KeyboardInterrupt:
                                return 0
                            raise RuntimeError("Demo engine exited unexpectedly")
                except Exception:
                    print("Engine log tail:\n" + log_path.read_text(errors="replace")[-6000:], file=sys.stderr)
                    raise
                finally:
                    stop(process)
        return 0
    except KeyboardInterrupt:
        print("FAIL: rehearsal interrupted", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous_handler)


if __name__ == "__main__":
    raise SystemExit(main())
