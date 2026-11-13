"""Notes, note discussion comments and votes."""

from orchestrator.shared import postgres


# Notes (the ONLY note store) -------------------------------------------------

NOTE_KINDS = ("note", "journal", "meeting", "idea", "checklist", "discussion")


# Must match the notes_fts_idx expression in shared/schema.py or the GIN index is not used.
_NOTE_TSV = "to_tsvector('english', title || ' ' || body)"


def note_create(title="", body="", kind="note", project_id=None, session_id=None,
                created_by="", pinned=False):
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO notes(title, body, kind, project_id, session_id, pinned, "
            "created_by, created_at, updated_at) "
            "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *",
            (title, body, kind if kind in NOTE_KINDS else "note", project_id, session_id,
             bool(pinned), created_by, postgres.now(), postgres.now()),
        )
        return dict(cur.fetchone())


def note_list(session_id=None, project_id=None, archived=False, q=None, kind=None, pinned=None):
    """Notes narrowed by any combination of filters (AND). `archived` selects
    the shelf: live notes by default, the archive when True. `q` is a full-text
    search over title and body (Postgres FTS, GIN-indexed) and orders by
    relevance; without it the order is pinned first, then most recently edited,
    the reading order of every notes app."""
    clauses, params = ["archived = %s"], [bool(archived)]
    if session_id is not None:
        clauses.append("session_id = %s"); params.append(session_id)
    if project_id is not None:
        clauses.append("project_id = %s"); params.append(project_id)
    if kind:
        clauses.append("kind = %s"); params.append(kind)
    if pinned is not None:
        clauses.append("pinned = %s"); params.append(bool(pinned))
    order = "pinned DESC, updated_at DESC, id DESC"
    select, rank_params = "*", []
    q = (q or "").strip()
    if q:
        clauses.append(f"{_NOTE_TSV} @@ websearch_to_tsquery('english', %s)"); params.append(q)
        order = f"ts_rank({_NOTE_TSV}, websearch_to_tsquery('english', %s)) DESC, " + order
        rank_params = [q]
    with postgres.cursor() as cur:
        cur.execute(f"SELECT {select} FROM notes WHERE " + " AND ".join(clauses) +
                    " ORDER BY " + order, params + rank_params)
        return [dict(r) for r in cur.fetchall()]


def note_get(note_id):
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM notes WHERE id = %s", (note_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def note_update(note_id, **fields):
    allowed = ("title", "body", "kind", "project_id", "pinned", "archived")
    sets = {k: v for k, v in fields.items() if k in allowed}
    if "kind" in sets and sets["kind"] not in NOTE_KINDS:
        del sets["kind"]
    if not sets:
        return note_get(note_id)
    sets["updated_at"] = postgres.now()
    cols = ", ".join(f"{k} = %s" for k in sets)
    with postgres.cursor() as cur:
        cur.execute(f"UPDATE notes SET {cols} WHERE id = %s RETURNING *",
                    (*sets.values(), note_id))
        row = cur.fetchone()
    return dict(row) if row else None


def note_delete(note_id):
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM notes WHERE id = %s", (note_id,))
        return cur.rowcount > 0


def notes_archive_for_session(session_id, archived):
    """Archiving a chat shelves its notes; unarchiving brings them back. Returns
    how many notes changed shelf."""
    with postgres.cursor() as cur:
        cur.execute("UPDATE notes SET archived = %s, updated_at = %s "
                    "WHERE session_id = %s AND archived <> %s",
                    (bool(archived), postgres.now(), session_id, bool(archived)))
        return cur.rowcount


def notes_delete_for_session(session_id):
    """A deleted chat takes its notes with it (same lifecycle as its loops and
    meta), and its comments on OTHER notes stop being a wake address (their
    text stays — it is part of someone else's thread). Returns the ids of the
    notes removed, so the caller can clear each note's discussion wakes — those
    are addressed to the RECIPIENT sessions, not this one, so a plain
    loop_delete_for_session(session_id) would miss them (see
    discussion.purge_session_notes)."""
    with postgres.cursor() as cur:
        cur.execute("UPDATE note_comments SET session_id = '' WHERE session_id = %s",
                    (session_id,))
        cur.execute("DELETE FROM notes WHERE session_id = %s RETURNING id", (session_id,))
        return [r["id"] for r in cur.fetchall()]


# Note discussions (the message board under every note) ----------------------

def note_comment_add(note_id, parent_id, author, session_id, body):
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO note_comments(note_id, parent_id, author, session_id, body, created_at) "
            "VALUES(%s,%s,%s,%s,%s,%s) RETURNING *",
            (note_id, parent_id, author, session_id or "", body, postgres.now()))
        return {**dict(cur.fetchone()), "score": 0, "my_vote": 0}


def note_comment_get(comment_id):
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM note_comments WHERE id = %s", (comment_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def note_comment_list(note_id, voter=""):
    """A note's comments, flat in posting order, each with its vote `score` and
    `voter`'s own vote (`my_vote`). discussion.thread() shapes them."""
    with postgres.cursor() as cur:
        cur.execute(
            "SELECT c.*, COALESCE(SUM(v.value), 0)::int AS score, "
            "COALESCE(MAX(CASE WHEN v.voter = %s THEN v.value END), 0)::int AS my_vote "
            "FROM note_comments c LEFT JOIN note_votes v ON v.comment_id = c.id "
            "WHERE c.note_id = %s GROUP BY c.id ORDER BY c.created_at, c.id",
            (voter or "", note_id))
        return [dict(r) for r in cur.fetchall()]


def note_vote_set(comment_id, voter, value):
    """Cast (+1/-1) or withdraw (0) one voter's vote. Returns the new score."""
    with postgres.cursor() as cur:
        if value:
            cur.execute("INSERT INTO note_votes(comment_id, voter, value) VALUES(%s,%s,%s) "
                        "ON CONFLICT (comment_id, voter) DO UPDATE SET value = EXCLUDED.value",
                        (comment_id, voter, value))
        else:
            cur.execute("DELETE FROM note_votes WHERE comment_id = %s AND voter = %s",
                        (comment_id, voter))
        cur.execute("SELECT COALESCE(SUM(value), 0)::int AS score FROM note_votes "
                    "WHERE comment_id = %s", (comment_id,))
        return cur.fetchone()["score"]


def note_comment_stats():
    """{note_id: {"replies": n, "last_reply_at": t}} — the list rows'
    "3 replies · active 2h ago"."""
    with postgres.cursor() as cur:
        cur.execute("SELECT note_id, COUNT(*) AS n, MAX(created_at) AS last_at "
                    "FROM note_comments GROUP BY note_id")
        return {r["note_id"]: {"replies": r["n"], "last_reply_at": r["last_at"]}
                for r in cur.fetchall()}
