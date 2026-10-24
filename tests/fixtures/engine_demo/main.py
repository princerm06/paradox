from contextlib import closing
import os
from pathlib import Path
import sqlite3

from fastapi import FastAPI

from demo_app import ranking


database_path = Path(os.environ["PARADOX_APP_DIR"]) / "app.sqlite3"
with closing(sqlite3.connect(database_path)) as connection:
    connection.execute("CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY, content TEXT, likes INTEGER, created_at TEXT)")
    if not connection.execute("SELECT 1 FROM posts").fetchone():
        connection.executemany("INSERT INTO posts VALUES (?,?,?,?)", [(1, "older", 8, "2026-01-01"), (2, "newer", 1, "2026-01-02")])
    connection.commit()

app = FastAPI()


@app.get("/health")
def health():
    return {"ordering": ranking.ORDERING}


@app.get("/redirect-target/")
def redirect_target():
    return {"status": "ok"}


@app.get("/api/posts")
def posts():
    with closing(sqlite3.connect(database_path)) as connection:
        connection.row_factory = sqlite3.Row
        records = [dict(row) for row in connection.execute("SELECT * FROM posts")]
    return {"ordering": ranking.ORDERING, "posts": ranking.rank(records)}


@app.post("/api/posts", status_code=201)
def publish(body: dict):
    with closing(sqlite3.connect(database_path)) as connection:
        connection.execute("INSERT INTO posts (content,likes,created_at) VALUES (?,0,'2026-02-01')", (body["content"],))
        connection.commit()
    return body
