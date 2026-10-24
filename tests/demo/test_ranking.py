from copy import deepcopy

from demo_app import ranking


def test_chronological_ranking_ignores_popularity_and_does_not_mutate():
    posts = [
        {'id': 1, 'created_at': '2026-01-01T12:00:00+00:00', 'likes': 8},
        {'id': 2, 'created_at': '2026-01-02T12:00:00+00:00', 'likes': 1},
    ]
    original = deepcopy(posts)
    ranked = ranking.rank(posts)
    assert ranking.ORDERING == 'chronological'
    assert [post['id'] for post in ranked] == [2, 1]
    assert ranked is not posts
    assert posts == original


def test_chronological_ranking_uses_id_to_break_timestamp_ties():
    posts = [
        {'id': 1, 'created_at': '2026-01-01T12:00:00+00:00', 'likes': 100},
        {'id': 3, 'created_at': '2026-01-01T12:00:00+00:00', 'likes': 0},
        {'id': 2, 'created_at': '2026-01-01T12:00:00+00:00', 'likes': 10},
    ]
    assert [post['id'] for post in ranking.rank(posts)] == [3, 2, 1]


def test_rank_handles_empty_and_single_post_lists():
    assert ranking.rank([]) == []
    posts = [{'id': 1, 'created_at': '2026-01-01T00:00:00+00:00', 'likes': 0}]
    assert ranking.rank(posts) == posts
    assert ranking.rank(posts) is not posts
