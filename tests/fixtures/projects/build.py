from pathlib import Path
import subprocess


RANKING = '''ORDERING = "chronological"

def rank(notes):
    return sorted(notes, key=lambda note: note["id"], reverse=True)
'''

POPULAR_RANKING = '''ORDERING = "priority"

def rank(notes):
    return sorted(notes, key=lambda note: (note["priority"], note["id"]), reverse=True)
'''

APPLICATION = '''import os
from pathlib import Path
import sqlite3

from fastapi import FastAPI
from pydantic import BaseModel, Field
from notes_app import ranking

app = FastAPI()
state = Path(os.environ["PARADOX_APP_DIR"])
database = state / "notes.sqlite3"

class NewNote(BaseModel):
    content: str = Field(min_length=1, max_length=300)
    priority: int = 0

def connection():
    state.mkdir(parents=True, exist_ok=True)
    current = sqlite3.connect(str(database))
    current.row_factory = sqlite3.Row
    current.execute("PRAGMA journal_mode=DELETE")
    current.execute("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, content TEXT NOT NULL, priority INTEGER NOT NULL)")
    if not current.execute("SELECT COUNT(*) FROM notes").fetchone()[0]:
        current.executemany("INSERT INTO notes VALUES (?,?,?)", [(1, "Older important note", 8), (2, "Newer note", 1)])
    current.commit()
    return current

@app.get("/health")
def health():
    return {"status": "ok", "ordering": ranking.ORDERING}

@app.get("/api/notes")
def notes():
    current = connection()
    try:
        rows = [dict(row) for row in current.execute("SELECT * FROM notes")]
        return {"notes": ranking.rank(rows), "ordering": ranking.ORDERING}
    finally:
        current.close()

@app.post("/api/notes", status_code=201)
def create_note(note: NewNote):
    current = connection()
    try:
        cursor = current.execute("INSERT INTO notes (content,priority) VALUES (?,?)", (note.content, note.priority))
        current.commit()
        return {"id": cursor.lastrowid, "content": note.content, "priority": note.priority}
    finally:
        current.close()
'''

CONFTEST = '''import importlib
import sys
from fastapi.testclient import TestClient
import pytest

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PARADOX_APP_DIR", str(tmp_path / "notes-state"))
    sys.modules.pop("notes_app.main", None)
    module = importlib.import_module("notes_app.main")
    with TestClient(module.app) as connection:
        yield connection
'''

TESTS = '''def test_health(client):
    assert client.get("/health").json()["status"] == "ok"

def test_seeded_notes(client):
    notes = client.get("/api/notes").json()["notes"]
    assert len(notes) == 2
    assert {note["priority"] for note in notes} == {8, 1}

def test_writes_persist(client):
    result = client.post("/api/notes", json={"content": "Persistent note", "priority": 3})
    assert result.status_code == 201
    assert result.json() in client.get("/api/notes").json()["notes"]

def test_ranking_does_not_mutate():
    from notes_app.ranking import rank
    notes = [{"id": 1, "priority": 8}, {"id": 2, "priority": 1}]
    before = list(notes)
    assert rank(notes) is not notes
    assert notes == before
'''

GENERATED_TEST = '''def test_generated_priority_order(client):
    result = client.get("/api/notes").json()
    assert result["ordering"] == "priority"
    assert [note["priority"] for note in result["notes"]] == [8, 1]
'''


def build_notes_repo(tmp_path):
    root = Path(tmp_path) / "notes-repo"
    root.mkdir()
    entries = {
        "notes_app/__init__.py": "",
        "notes_app/main.py": APPLICATION,
        "notes_app/ranking.py": RANKING,
        "tests/conftest.py": CONFTEST,
        "tests/test_notes.py": TESTS,
        "requirements.txt": "fastapi\nuvicorn\nhttpx\npytest\n",
    }
    for relative, content in entries.items():
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding="utf-8")
    environment = {"PATH": "/usr/bin:/bin", "HOME": str(root)}
    for arguments in (("init", "-b", "main"), ("add", "."),
                      ("-c", "user.name=Disposable", "-c", "user.email=fixture@example.invalid", "commit", "-m", "notes fixture")):
        subprocess.run(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-C", str(root), *arguments],
                       check=True, capture_output=True, env=environment)
    return root.resolve()
