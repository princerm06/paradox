import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from demo_app import ranking
from demo_app.main import create_app


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        yield client


def test_seeded_feed_and_health(client):
    response = client.get('/api/posts')
    assert response.status_code == 200
    feed = response.json()
    assert feed['ordering'] == 'chronological'
    assert [post['id'] for post in feed['posts']] == [2, 1]
    assert [post['likes'] for post in feed['posts']] == [1, 8]
    assert client.get('/health').json() == {'status': 'ok', 'ordering': 'chronological'}
    assert client.get('/api/health').json() == client.get('/health').json()
    page = client.get('/')
    assert page.status_code == 200
    assert "request('api/posts'" in page.text
    assert 'content.textContent = post.content' in page.text


def test_create_and_like_persist_across_restart(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        response = client.post('/api/posts', json={'author': ' Explorer ', 'content': ' New future '})
        assert response.status_code == 201
        post = response.json()
        assert post['author'] == 'Explorer'
        assert post['content'] == 'New future'
        assert post['likes'] == 0
        assert client.post(f"/api/posts/{post['id']}/like").json()['likes'] == 1
    with TestClient(create_app(tmp_path)) as client:
        posts = client.get('/api/posts').json()['posts']
        assert len(posts) == 3
        assert posts[0]['id'] == post['id']
        assert posts[0]['likes'] == 1
    with sqlite3.connect(str(tmp_path / 'app.sqlite3')) as connection:
        assert connection.execute('PRAGMA journal_mode').fetchone()[0] == 'delete'
    assert not (tmp_path / 'app.sqlite3-wal').exists()


def test_popular_order_and_deterministic_ties(tmp_path, monkeypatch):
    def popular_rank(posts):
        return sorted(posts, key=lambda post: (post['likes'], post['created_at'], post['id']), reverse=True)

    monkeypatch.setattr(ranking, 'ORDERING', 'popular')
    monkeypatch.setattr(ranking, 'rank', popular_rank)
    with TestClient(create_app(tmp_path)) as client:
        feed = client.get('/api/posts').json()
        assert feed['ordering'] == 'popular'
        assert [post['id'] for post in feed['posts']] == [1, 2]
        for _ in range(7):
            assert client.post('/api/posts/2/like').status_code == 200
        assert [post['id'] for post in client.get('/api/posts').json()['posts']] == [2, 1]
    with sqlite3.connect(str(tmp_path / 'app.sqlite3')) as connection:
        connection.execute('UPDATE posts SET created_at = ?', ('2026-01-01T00:00:00+00:00',))
    with TestClient(create_app(tmp_path)) as client:
        assert [post['id'] for post in client.get('/api/posts').json()['posts']] == [2, 1]


@pytest.mark.parametrize('payload', [
    {}, {'author': '', 'content': 'hello'}, {'author': '  ', 'content': 'hello'},
    {'author': 'Ada', 'content': '  '}, {'author': 'a' * 81, 'content': 'hello'},
    {'author': 'Ada', 'content': 'a' * 2001},
])
def test_invalid_posts_do_not_write(client, payload):
    assert client.post('/api/posts', json=payload).status_code == 422
    assert len(client.get('/api/posts').json()['posts']) == 2


def test_unknown_like_and_parameterized_content(client):
    assert client.post('/api/posts/99999/like').status_code == 404
    content = "'); DROP TABLE posts; -- <script>alert(1)</script>"
    response = client.post('/api/posts', json={'author': 'Ada', 'content': content})
    assert response.status_code == 201
    assert response.json()['content'] == content
    assert len(client.get('/api/posts').json()['posts']) == 3


def test_concurrent_likes_do_not_lose_updates(client):
    with ThreadPoolExecutor(max_workers=8) as executor:
        responses = list(executor.map(lambda _: client.post('/api/posts/1/like'), range(20)))
    assert all(response.status_code == 200 for response in responses)
    posts = client.get('/api/posts').json()['posts']
    assert next(post for post in posts if post['id'] == 1)['likes'] == 28


def test_invalid_ranking_fails_readiness(tmp_path, monkeypatch):
    monkeypatch.setattr(ranking, 'ORDERING', 'unexpected')
    with pytest.raises(ValueError, match='ranking.ORDERING'):
        with TestClient(create_app(tmp_path)):
            pass


def test_legacy_behavior_file_cannot_select_popularity(tmp_path):
    (tmp_path / 'behavior.json').write_text('{"feed_order":"popular"}')
    with TestClient(create_app(tmp_path)) as client:
        feed = client.get('/api/posts').json()
        assert feed['ordering'] == 'chronological'
        assert [post['id'] for post in feed['posts']] == [2, 1]


def test_feed_delegates_all_ordering_to_ranking(client, monkeypatch):
    calls = []

    def reverse_ids(posts):
        calls.append(posts)
        return sorted(posts, key=lambda post: post['id'])

    monkeypatch.setattr(ranking, 'rank', reverse_ids)
    feed = client.get('/api/posts').json()
    assert [post['id'] for post in feed['posts']] == [1, 2]
    assert len(calls) == 1
    assert all(isinstance(post, dict) for post in calls[0])
    assert feed['ordering'] == ranking.ORDERING


def test_distinct_state_directories_are_isolated(tmp_path):
    with TestClient(create_app(tmp_path / 'first')) as first:
        first.post('/api/posts', json={'author': 'Ada', 'content': 'Only in first'})
        with TestClient(create_app(tmp_path / 'second')) as second:
            assert len(second.get('/api/posts').json()['posts']) == 2
        assert len(first.get('/api/posts').json()['posts']) == 3
