"""Saves alerts, API calls and de-duplication state, so they survive restarts and redeploys.

DATABASE_URL picks where:
  sqlite:///data/triage.db           a local file (relative paths are under the project folder)
  postgresql://user:pass@host/db     Postgres, e.g. a Render or Neon database (needed on Render:
                                     its disk is wiped on every deploy)
  (empty)                            nothing is saved; everything lives in memory only

The in-memory stores stay the read path (fast); every change is also written here,
and on startup the stores are loaded back from here.
"""

import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from app.models import ApiCall, Investigation

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS investigations (
         id TEXT PRIMARY KEY,
         created_at TEXT NOT NULL,
         data TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS api_calls (
         id {autoid},
         app TEXT NOT NULL,
         method TEXT NOT NULL,
         path TEXT NOT NULL,
         status INTEGER NOT NULL,
         duration_ms DOUBLE PRECISION NOT NULL,
         time TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS dedup (
         fingerprint TEXT PRIMARY KEY,
         investigation_id TEXT NOT NULL,
         first_seen DOUBLE PRECISION NOT NULL,
         count INTEGER NOT NULL)""",
]


class Database:
    def __init__(self, url: str, project_root: Path):
        self.url = url
        self.is_postgres = url.startswith(("postgres://", "postgresql://"))
        self.lock = threading.Lock()  # one writer at a time (SQLite needs it; harmless for Postgres)
        if self.is_postgres:
            import psycopg  # only needed when Postgres is used

            self.psycopg = psycopg
        elif url.startswith("sqlite:///"):
            path = Path(url.removeprefix("sqlite:///"))
            self.path = path if path.is_absolute() else project_root / path
            self.path.parent.mkdir(parents=True, exist_ok=True)
        else:
            raise ValueError(f"DATABASE_URL must start with sqlite:/// or postgresql://, got {url!r}")
        autoid = "BIGSERIAL PRIMARY KEY" if self.is_postgres else "INTEGER PRIMARY KEY AUTOINCREMENT"
        with self.connect() as conn:
            for statement in SCHEMA:
                conn.execute(statement.format(autoid=autoid))

    @contextmanager
    def connect(self):
        """A connection that commits on success. Each operation opens its own, so a dropped
        Postgres connection never breaks the app for good."""
        with self.lock:
            if self.is_postgres:
                with self.psycopg.connect(self.url) as conn:  # commits on exit
                    yield _Postgres(conn)
            else:
                conn = sqlite3.connect(self.path)
                try:
                    yield conn
                    conn.commit()
                finally:
                    conn.close()

    def sql(self, statement: str) -> str:
        return statement.replace("?", "%s") if self.is_postgres else statement

    # ------------------------------------------------------------------ investigations

    def save_investigation(self, inv: Investigation) -> None:
        with self.connect() as conn:
            conn.execute(
                self.sql("INSERT INTO investigations (id, created_at, data) VALUES (?, ?, ?) "
                         "ON CONFLICT (id) DO UPDATE SET data = excluded.data"),
                (inv.id, inv.created_at.isoformat(), inv.model_dump_json()),
            )

    def delete_investigation(self, investigation_id: str) -> None:
        with self.connect() as conn:
            conn.execute(self.sql("DELETE FROM investigations WHERE id = ?"), (investigation_id,))

    def load_investigations(self, limit: int) -> list[Investigation]:
        """The newest `limit` investigations, oldest first (the store's insertion order)."""
        with self.connect() as conn:
            rows = conn.execute(
                self.sql("SELECT data FROM investigations ORDER BY created_at DESC LIMIT ?"), (limit,)
            ).fetchall()
        return [Investigation.model_validate_json(data) for (data,) in reversed(rows)]

    # ------------------------------------------------------------------ API calls

    def add_calls(self, calls: list[ApiCall], keep: int) -> None:
        if not calls:
            return
        rows = [(c.app, c.method, c.path, c.status, c.duration_ms, c.time.isoformat()) for c in calls]
        with self.connect() as conn:
            conn.executemany(
                self.sql("INSERT INTO api_calls (app, method, path, status, duration_ms, time) VALUES (?, ?, ?, ?, ?, ?)"),
                rows,
            )
            # Keep only the newest `keep` calls, like the in-memory store.
            conn.execute(
                self.sql("DELETE FROM api_calls WHERE id <= "
                         "(SELECT id FROM api_calls ORDER BY id DESC LIMIT 1 OFFSET ?)"),
                (keep,),
            )

    def load_calls(self, limit: int) -> list[ApiCall]:
        with self.connect() as conn:
            rows = conn.execute(
                self.sql("SELECT app, method, path, status, duration_ms, time FROM api_calls "
                         "ORDER BY id DESC LIMIT ?"), (limit,)
            ).fetchall()
        return [
            ApiCall(app=a, method=m, path=p, status=s, duration_ms=d, time=datetime.fromisoformat(t))
            for a, m, p, s, d, t in reversed(rows)
        ]

    # ------------------------------------------------------------------ de-duplication

    def save_dedup(self, fp: str, entry: dict) -> None:
        with self.connect() as conn:
            conn.execute(
                self.sql("INSERT INTO dedup (fingerprint, investigation_id, first_seen, count) VALUES (?, ?, ?, ?) "
                         "ON CONFLICT (fingerprint) DO UPDATE SET investigation_id = excluded.investigation_id, "
                         "first_seen = excluded.first_seen, count = excluded.count"),
                (fp, entry["investigation_id"], entry["first_seen"], entry["count"]),
            )

    def load_dedup(self, newer_than: float) -> dict[str, dict]:
        with self.connect() as conn:
            conn.execute(self.sql("DELETE FROM dedup WHERE first_seen < ?"), (newer_than,))
            rows = conn.execute("SELECT fingerprint, investigation_id, first_seen, count FROM dedup").fetchall()
        return {fp: {"investigation_id": i, "first_seen": f, "count": n} for fp, i, f, n in rows}


class _Postgres:
    """Gives a psycopg connection the sqlite3-style conn.execute(...).fetchall() / executemany."""

    def __init__(self, conn):
        self.conn = conn

    def execute(self, statement, params=()):
        return self.conn.execute(statement, params)

    def executemany(self, statement, rows):
        with self.conn.cursor() as cur:
            cur.executemany(statement, rows)


def open_database(url: str, project_root: Path) -> Database | None:
    return Database(url, project_root) if url else None

