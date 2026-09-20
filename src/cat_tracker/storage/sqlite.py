import sqlite3
from dataclasses import astuple
from pathlib import Path

from ..models import Notification, State, Tag


class Store:
    """Owned by one asyncio event loop; methods never await inside transactions."""

    def __init__(self, path: str):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS states (
                tag_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at REAL NOT NULL,
                last_seen REAL, last_rssi INTEGER, alert_sent INTEGER NOT NULL DEFAULT 0,
                missing_since REAL, episode INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT, tag_id TEXT NOT NULL,
                episode INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0, next_attempt REAL NOT NULL DEFAULT 0,
                UNIQUE(tag_id, episode, kind)
            );
            PRAGMA user_version=1;
        """)

    def load(self, tags: list[Tag], now: float) -> dict[str, State]:
        result = {}
        with self.db:
            for tag in tags:
                row = self.db.execute("SELECT * FROM states WHERE tag_id=?", (tag.id,)).fetchone()
                state = State(**dict(row)) if row else State(tag.id, tag.name, now)
                state.name = tag.name
                self.save(state)
                result[tag.id] = state
        return result

    def save(self, state: State) -> None:
        self.db.execute("INSERT OR REPLACE INTO states VALUES (?,?,?,?,?,?,?,?)", astuple(state))

    def enqueue(self, state: State, kind: str, message: str) -> None:
        self.db.execute(
            "INSERT OR IGNORE INTO outbox(tag_id,episode,kind,message) VALUES(?,?,?,?)",
            (state.tag_id, state.episode, kind, message),
        )

    def next_notification(self, now: float, active_ids: list[str]) -> Notification | None:
        # Per-tag ordering; a failed delivery for A does not block B.
        rows = self.db.execute(
            """
            SELECT id,tag_id,episode,kind,message,attempts FROM outbox o
            WHERE next_attempt <= ? AND NOT EXISTS (
                SELECT 1 FROM outbox older WHERE older.tag_id=o.tag_id AND older.id<o.id
            ) ORDER BY id
        """,
            (now,),
        )
        return next((Notification(**dict(r)) for r in rows if r["tag_id"] in active_ids), None)

    def close(self) -> None:
        self.db.close()
