import os
import sqlite3
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, constr

from demo_app import ranking


class NewPost(BaseModel):
    author: constr(strip_whitespace=True, min_length=1, max_length=80)
    content: constr(strip_whitespace=True, min_length=1, max_length=2000)


class Post(BaseModel):
    id: int
    author: str
    content: str
    likes: int
    created_at: str


class Feed(BaseModel):
    posts: list[Post]
    ordering: str


@contextmanager
def database(path: Path):
    connection = sqlite3.connect(str(path), timeout=10)
    connection.row_factory = sqlite3.Row
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_database(path: Path):
    with database(path) as connection:
        connection.execute("PRAGMA journal_mode=DELETE")
        exists = connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='posts'"
        ).fetchone()
        connection.execute(
            "CREATE TABLE IF NOT EXISTS posts ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "author TEXT NOT NULL, content TEXT NOT NULL, "
            "likes INTEGER NOT NULL DEFAULT 0 CHECK (likes >= 0), "
            "created_at TEXT NOT NULL)"
        )
        if not exists:
            connection.executemany(
                "INSERT INTO posts (author, content, likes, created_at) VALUES (?, ?, ?, ?)",
                [
                    ("Ada", "An older post the community loves.", 8, "2026-01-01T12:00:00+00:00"),
                    ("Grace", "The newest update from the original timeline.", 1, "2026-01-02T12:00:00+00:00"),
                ],
            )


def create_app(app_dir: Optional[Path] = None) -> FastAPI:
    state_dir = Path(app_dir or os.environ.get("PARADOX_APP_DIR", ".paradox-demo"))
    database_path = state_dir / "app.sqlite3"

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        state_dir.mkdir(parents=True, exist_ok=True)
        if ranking.ORDERING not in {"chronological", "popular"}:
            raise ValueError("ranking.ORDERING must be chronological or popular")
        initialize_database(database_path)
        yield

    application = FastAPI(title="Paradox Demo Feed", lifespan=lifespan)

    @application.get("/", response_class=HTMLResponse)
    def index():
        return Path(__file__).with_name("index.html").read_text(encoding="utf-8")

    @application.get("/health")
    @application.get("/api/health")
    def health():
        with database(database_path) as connection:
            connection.execute("SELECT 1 FROM posts LIMIT 1").fetchone()
        return {"status": "ok", "ordering": ranking.ORDERING}

    @application.get("/api/posts", response_model=Feed)
    def list_posts():
        with database(database_path) as connection:
            posts = [dict(post) for post in connection.execute("SELECT * FROM posts").fetchall()]
        return {"posts": ranking.rank(posts), "ordering": ranking.ORDERING}

    @application.post("/api/posts", response_model=Post, status_code=201)
    def create_post(post: NewPost):
        with database(database_path) as connection:
            cursor = connection.execute(
                "INSERT INTO posts (author, content, created_at) VALUES (?, ?, ?)",
                (post.author, post.content, datetime.now(timezone.utc).isoformat()),
            )
            result = connection.execute("SELECT * FROM posts WHERE id = ?", (cursor.lastrowid,)).fetchone()
        return dict(result)

    @application.post("/api/posts/{post_id}/like", response_model=Post)
    def like_post(post_id: int):
        with database(database_path) as connection:
            cursor = connection.execute("UPDATE posts SET likes = likes + 1 WHERE id = ?", (post_id,))
            if cursor.rowcount == 0:
                raise HTTPException(status_code=404, detail="Post not found")
            result = connection.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
        return dict(result)

    return application


app = create_app()
