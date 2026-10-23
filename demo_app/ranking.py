"""Replace this module in a timeline's working code, then restart its runtime.

ORDERING labels the implementation in feed and health responses. rank accepts
post dictionaries and returns a new, deterministically ordered list without
mutating the input list or its posts. Ranking is independent of SQLite state.
"""

ORDERING = "chronological"


def rank(posts: list[dict]) -> list[dict]:
    return sorted(posts, key=lambda post: (post["created_at"], post["id"]), reverse=True)
