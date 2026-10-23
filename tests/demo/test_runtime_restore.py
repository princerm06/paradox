from contextlib import contextmanager
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import time

import httpx


POPULAR_RANKING = '''ORDERING = "popular"


def rank(posts: list[dict]) -> list[dict]:
    return sorted(
        posts,
        key=lambda post: (post["likes"], post["created_at"], post["id"]),
        reverse=True,
    )
'''


@contextmanager
def running_demo(code_dir, state_dir, log_path):
    environment = os.environ.copy()
    environment.pop('PYTHONPATH', None)
    environment['PARADOX_APP_DIR'] = str(state_dir)
    environment['PYTHONDONTWRITEBYTECODE'] = '1'
    with socket.socket() as listener, log_path.open('ab') as log:
        listener.bind(('127.0.0.1', 0))
        listener.listen(128)
        port = listener.getsockname()[1]
        process = subprocess.Popen(
            [sys.executable, '-m', 'uvicorn', 'demo_app.main:app', '--fd', str(listener.fileno()), '--log-level', 'warning'],
            cwd=code_dir,
            env=environment,
            pass_fds=(listener.fileno(),),
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        listener.close()
        try:
            with httpx.Client(base_url=f'http://127.0.0.1:{port}', trust_env=False, timeout=1) as client:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    assert process.poll() is None, log_path.read_text()
                    try:
                        if client.get('/health').status_code == 200:
                            break
                    except httpx.HTTPError:
                        pass
                    time.sleep(0.05)
                else:
                    raise AssertionError('Demo runtime did not become ready: ' + log_path.read_text())
                yield client
        finally:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def test_source_replacement_restart_and_database_restoration(tmp_path):
    source = Path(__file__).resolve().parents[2] / 'demo_app'
    code_dir = tmp_path / 'code'
    state_dir = tmp_path / 'state'
    log_path = tmp_path / 'runtime.log'
    shutil.copytree(source, code_dir / 'demo_app', ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    ranking_path = code_dir / 'demo_app' / 'ranking.py'
    original_ranking = ranking_path.read_bytes()
    database_path = state_dir / 'app.sqlite3'
    snapshot_path = tmp_path / 'original.sqlite3'

    with running_demo(code_dir, state_dir, log_path) as client:
        baseline = client.get('/api/posts').json()
        assert baseline['ordering'] == 'chronological'
        assert [post['id'] for post in baseline['posts']] == [2, 1]
    with sqlite3.connect(str(database_path)) as live:
        with sqlite3.connect(str(snapshot_path)) as snapshot:
            live.backup(snapshot)

    ranking_path.write_text(POPULAR_RANKING)
    with running_demo(code_dir, state_dir, log_path) as client:
        popular = client.get('/api/posts').json()
        assert popular['ordering'] == 'popular'
        assert [post['id'] for post in popular['posts']] == [1, 2]
        assert sorted(popular['posts'], key=lambda post: post['id']) == sorted(baseline['posts'], key=lambda post: post['id'])
        assert client.get('/health').json()['ordering'] == 'popular'
        created = client.post('/api/posts', json={'author': 'Explorer', 'content': 'Popular future only'})
        assert created.status_code == 201
        future_post = created.json()
        assert client.post(f"/api/posts/{future_post['id']}/like").json()['likes'] == 1

    with running_demo(code_dir, state_dir, log_path) as client:
        feed = client.get('/api/posts').json()
        assert feed['ordering'] == 'popular'
        assert len(feed['posts']) == 3
        assert next(post for post in feed['posts'] if post['id'] == future_post['id'])['likes'] == 1

    with sqlite3.connect(str(snapshot_path)) as snapshot:
        with sqlite3.connect(str(database_path)) as live:
            snapshot.backup(live)
    with running_demo(code_dir, state_dir, log_path) as client:
        feed = client.get('/api/posts').json()
        assert feed['ordering'] == 'popular'
        assert [post['id'] for post in feed['posts']] == [1, 2]

    ranking_path.write_bytes(original_ranking)
    with running_demo(code_dir, state_dir, log_path) as client:
        assert client.get('/api/posts').json() == baseline
        assert client.get('/api/health').json()['ordering'] == 'chronological'
    assert ranking_path.read_bytes() == original_ranking
    assert not (state_dir / 'app.sqlite3-wal').exists()
