from copy import deepcopy

from demo_app import ranking


def test_ranking_preserves_posts_and_does_not_mutate_input():
    posts = [
        {'id': 1, 'created_at': '2026-01-01T12:00:00+00:00', 'likes': 8, 'content': 'Older'},
        {'id': 2, 'created_at': '2026-01-02T12:00:00+00:00', 'likes': 1, 'content': 'Newer'},
    ]
    original = deepcopy(posts)
    result = ranking.rank(posts)
    assert result is not posts
    assert posts == original
    assert sorted(result, key=lambda post: post['id']) == original
    assert ranking.rank(posts) == result


def test_ranking_handles_empty_and_single_post_lists():
    assert ranking.rank([]) == []
    posts = [{'id': 1, 'created_at': '2026-01-01T00:00:00+00:00', 'likes': 0}]
    result = ranking.rank(posts)
    assert result == posts
    assert result is not posts


def test_ranking_breaks_equal_timestamp_and_like_ties_by_id():
    posts = [
        {'id': post_id, 'created_at': '2026-01-01T00:00:00+00:00', 'likes': 3}
        for post_id in [1, 3, 2]
    ]
    assert [post['id'] for post in ranking.rank(posts)] == [3, 2, 1]


def test_feed_order_is_produced_by_ranking_module(client):
    posts = client.get('/api/posts').json()['posts']
    assert posts == ranking.rank(posts)
