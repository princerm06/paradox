import sqlite3

from fastapi.testclient import TestClient

from demo_app.main import create_app


def test_restart_preserves_posts_and_likes_without_reseeding(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        response = client.post('/api/posts', json={'author': 'Explorer', 'content': 'Survives restart'})
        assert response.status_code == 201
        post_id = response.json()['id']
        assert client.post(f'/api/posts/{post_id}/like').status_code == 200
        before = client.get('/api/posts').json()
    with TestClient(create_app(tmp_path)) as client:
        assert client.get('/api/posts').json() == before
        assert len(before['posts']) == 3


def test_sqlite_backup_restores_exact_previous_data(tmp_path):
    state_dir = tmp_path / 'state'
    database_path = state_dir / 'app.sqlite3'
    snapshot_path = tmp_path / 'snapshot.sqlite3'
    with TestClient(create_app(state_dir)) as client:
        baseline = client.get('/api/posts').json()
    with sqlite3.connect(str(database_path)) as live:
        assert live.execute('PRAGMA journal_mode').fetchone()[0] == 'delete'
        with sqlite3.connect(str(snapshot_path)) as snapshot:
            live.backup(snapshot)
    with TestClient(create_app(state_dir)) as client:
        assert client.post('/api/posts', json={'author': 'Ada', 'content': 'After snapshot'}).status_code == 201
        assert client.post('/api/posts/1/like').status_code == 200
    with sqlite3.connect(str(snapshot_path)) as snapshot:
        with sqlite3.connect(str(database_path)) as live:
            snapshot.backup(live)
    with TestClient(create_app(state_dir)) as client:
        assert client.get('/api/posts').json() == baseline


def test_separate_state_directories_never_share_writes(tmp_path):
    with TestClient(create_app(tmp_path / 'first')) as first:
        assert first.post('/api/posts', json={'author': 'Ada', 'content': 'First only'}).status_code == 201
        with TestClient(create_app(tmp_path / 'second')) as second:
            assert len(second.get('/api/posts').json()['posts']) == 2
        assert len(first.get('/api/posts').json()['posts']) == 3
