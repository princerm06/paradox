import pytest

from demo_app import ranking


def test_feed_exposes_existing_post_contract(client):
    response = client.get('/api/posts')
    assert response.status_code == 200
    feed = response.json()
    assert feed['ordering'] == ranking.ORDERING
    posts = feed['posts']
    assert {post['id'] for post in posts} == {1, 2}
    for post in posts:
        assert {'id', 'author', 'content', 'likes', 'created_at'} <= post.keys()
        assert isinstance(post['author'], str)
        assert isinstance(post['content'], str)
        assert isinstance(post['likes'], int)
        assert post['likes'] >= 0
    assert {post['likes'] for post in posts} == {1, 8}


def test_health_aliases_and_page_remain_available(client):
    expected = {'status': 'ok', 'ordering': ranking.ORDERING}
    assert client.get('/health').json() == expected
    assert client.get('/api/health').json() == expected
    response = client.get('/')
    assert response.status_code == 200
    assert 'text/html' in response.headers['content-type']


def test_create_and_like_preserve_existing_semantics(client):
    response = client.post('/api/posts', json={'author': ' Ada ', 'content': ' A new future '})
    assert response.status_code == 201
    post = response.json()
    assert post['author'] == 'Ada'
    assert post['content'] == 'A new future'
    assert post['likes'] == 0
    response = client.post(f"/api/posts/{post['id']}/like")
    assert response.status_code == 200
    assert response.json()['likes'] == 1
    posts = client.get('/api/posts').json()['posts']
    assert next(candidate for candidate in posts if candidate['id'] == post['id'])['likes'] == 1


@pytest.mark.parametrize('payload', [
    {},
    {'author': '', 'content': 'Hello'},
    {'author': '  ', 'content': 'Hello'},
    {'author': 'Ada', 'content': '  '},
    {'author': 'a' * 81, 'content': 'Hello'},
    {'author': 'Ada', 'content': 'a' * 2001},
])
def test_invalid_posts_do_not_modify_database(client, payload):
    before = client.get('/api/posts').json()
    assert client.post('/api/posts', json=payload).status_code == 422
    assert client.get('/api/posts').json() == before


def test_missing_like_returns_404_without_writing(client):
    before = client.get('/api/posts').json()
    assert client.post('/api/posts/999999/like').status_code == 404
    assert client.get('/api/posts').json() == before


def test_post_content_remains_data_not_sql(client):
    content = "'); DROP TABLE posts; -- <script>alert(1)</script>"
    response = client.post('/api/posts', json={'author': 'Ada', 'content': content})
    assert response.status_code == 201
    assert response.json()['content'] == content
    assert len(client.get('/api/posts').json()['posts']) == 3
