ORDERING = "popular"


def rank(posts):
    return sorted(
        posts,
        key=lambda post: (post["likes"], post["created_at"], post["id"]),
        reverse=True,
    )
