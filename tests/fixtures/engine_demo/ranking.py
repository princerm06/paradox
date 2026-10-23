ORDERING = "chronological"


def rank(posts):
    return sorted(posts, key=lambda post: (post["created_at"], post["id"]), reverse=True)
