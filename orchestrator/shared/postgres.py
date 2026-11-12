"""Postgres connection pool and the one cursor every repository uses."""
import os
import threading
import time
from contextlib import contextmanager

import psycopg2
import psycopg2.pool
from psycopg2.extras import RealDictCursor


def default_dsn():
    """The database to use when DATABASE_URL is unset: the local `viewer` DB.
    POSIX reaches it over the unix socket (peer auth); Windows Postgres has no
    unix socket, so there it is TCP on the standard port."""
    if os.name == "nt":
        return "dbname=viewer host=localhost port=5432"
    return "dbname=viewer"


DATABASE_URL = os.environ.get("DATABASE_URL") or default_dsn()

_pool = None
_pool_lock = threading.Lock()


def _get_pool():
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                _pool = psycopg2.pool.ThreadedConnectionPool(1, 16, dsn=DATABASE_URL)
    return _pool


@contextmanager
def cursor():
    """One transaction on a pooled connection, yielding a RealDictCursor. Repositories
    hold dumb CRUD only; policy (gates, audit-on-action) lives above them."""
    pool = _get_pool()
    conn = pool.getconn()
    try:
        with conn:  # commits on clean exit, rolls back on exception (keeps the conn)
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                yield cur
    finally:
        pool.putconn(conn)


def close_pool():
    global _pool
    if _pool is not None:
        try:
            _pool.closeall()
        except Exception:
            pass
        _pool = None


def now():
    """The one clock every repository stamps rows with (patchable in tests)."""
    return time.time()
