"""The shared project canvas and the legacy per-session canvases."""

from orchestrator.shared import postgres


# The retired per-session canvas pane (migrated at boot, then dropped) ------

def legacy_canvases():
    """Rows of the retired `canvases` table, or None once it is gone."""
    with postgres.cursor() as cur:
        cur.execute("SELECT to_regclass('canvases') AS t")
        if cur.fetchone()["t"] is None:
            return None
        cur.execute("SELECT session_id, title, kind, content FROM canvases ORDER BY updated_at")
        return [dict(r) for r in cur.fetchall()]


def legacy_canvases_drop():
    with postgres.cursor() as cur:
        cur.execute("DROP TABLE IF EXISTS canvases")


# The shared canvas (Excalidraw boards) --------------------------------------

def canvas_board_for(owner_kind, owner_id, title=""):
    """The board a project (or session) owns, created on first use."""
    now = postgres.now()
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO canvas_boards (owner_kind, owner_id, title, created_at, updated_at) "
            "VALUES (%s, %s, %s, %s, %s) ON CONFLICT (owner_kind, owner_id) "
            "DO UPDATE SET owner_kind = EXCLUDED.owner_kind RETURNING *",
            (owner_kind, str(owner_id), title, now, now))
        return dict(cur.fetchone())


def canvas_board_get(canvas_id):
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM canvas_boards WHERE id = %s", (int(canvas_id),))
        row = cur.fetchone()
    return dict(row) if row else None


def canvas_elements_load(canvas_id):
    """Every stored element (tombstones included — peers need them to converge)."""
    with postgres.cursor() as cur:
        cur.execute("SELECT data FROM canvas_elements WHERE canvas_id = %s", (int(canvas_id),))
        return [r["data"] for r in cur.fetchall()]


def canvas_elements_upsert(canvas_id, elements, actor=""):
    """Batch-write elements. The WHERE guard keeps a stale flush from
    overwriting a newer row (same rule as canvas_reconcile.wins)."""
    if not elements:
        return
    from psycopg2.extras import Json, execute_batch
    now = postgres.now()
    rows = [(int(canvas_id), e["id"], int(e.get("version") or 0), int(e.get("versionNonce") or 0),
             bool(e.get("isDeleted")), Json(e), actor, now) for e in elements]
    with postgres.cursor() as cur:
        execute_batch(cur,
            "INSERT INTO canvas_elements AS c (canvas_id, element_id, version, version_nonce, "
            "is_deleted, data, updated_by, updated_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s) "
            "ON CONFLICT (canvas_id, element_id) DO UPDATE SET version = EXCLUDED.version, "
            "version_nonce = EXCLUDED.version_nonce, is_deleted = EXCLUDED.is_deleted, "
            "data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at "
            "WHERE EXCLUDED.version > c.version OR (EXCLUDED.version = c.version "
            "AND EXCLUDED.version_nonce < c.version_nonce)", rows, page_size=500)
        cur.execute("UPDATE canvas_boards SET updated_at = %s WHERE id = %s", (now, int(canvas_id)))


def canvas_tombstones_gc(older_than_s):
    """Drop deleted elements nobody has touched for `older_than_s` seconds."""
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM canvas_elements WHERE is_deleted AND updated_at < %s",
                    (postgres.now() - older_than_s,))
        return cur.rowcount


def canvas_file_put(canvas_id, file_id, mime, data, actor=""):
    with postgres.cursor() as cur:
        cur.execute("INSERT INTO canvas_files (canvas_id, file_id, mime, bytes, created_by, created_at) "
                    "VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                    (int(canvas_id), file_id, mime, data, actor, postgres.now()))


def canvas_file_get(canvas_id, file_id):
    with postgres.cursor() as cur:
        cur.execute("SELECT mime, bytes FROM canvas_files WHERE canvas_id = %s AND file_id = %s",
                    (int(canvas_id), file_id))
        row = cur.fetchone()
    return (row["mime"], bytes(row["bytes"])) if row else None
