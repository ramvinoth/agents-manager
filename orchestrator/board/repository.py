"""Projects, board columns, cards, card comments, dependencies and card asks."""
import os

from orchestrator import orglogic
from orchestrator.shared import postgres


# Projects --------------------------------------------------------------------

# Every project gets this column layout the moment it's created. The decision
# pipeline (Review = needs the owner's call, then Approved / Declined) sits
# between Doing and Done; Done stays last (task_done and the position fallbacks
# key on the final column). New projects get the full tuple here; projects
# created before the decision columns existed are fixed up by
# board_columns_ensure at every server start (idempotent no-op once done).
_DEFAULT_COLUMNS = orglogic.PIPELINE_COLUMNS


def project_create(name, description="", host="local", cwd="", created_by=""):
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO projects(name, description, host, cwd, created_by, created_at) "
            "VALUES(%s,%s,%s,%s,%s,%s) RETURNING *",
            (name, description, host, cwd, created_by, postgres.now()),
        )
        proj = dict(cur.fetchone())
        for i, cname in enumerate(_DEFAULT_COLUMNS):
            cur.execute(
                "INSERT INTO board_columns(project_id, name, position) VALUES(%s,%s,%s)",
                (proj["id"], cname, i),
            )
    return proj


def project_list():
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM projects ORDER BY id")
        return [dict(r) for r in cur.fetchall()]


def project_get(project_id):
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM projects WHERE id = %s", (project_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def project_get_by_cwd(host, cwd):
    cwd = _norm_cwd(host, cwd)
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM projects WHERE host = %s AND cwd = %s ORDER BY id LIMIT 1",
                    (host, cwd))
        row = cur.fetchone()
    return dict(row) if row else None


def project_ensure(host, cwd, name, created_by=""):
    """Find-or-create the org project for a (host, cwd) directory. The single
    bridge between the LHS's cwd-keyed projects and the org board — resolved
    server-side so no client duplicates the mapping. cwd is normalized (tilde
    expanded on local) so the web entry point and a spawned agent session, which
    may pass the same dir in different forms, always land on ONE project. New
    projects get the default columns via project_create."""
    cwd = _norm_cwd(host, cwd)
    existing = project_get_by_cwd(host, cwd)
    if existing:
        return existing
    return project_create(name or cwd, "", host, cwd, created_by)


def project_delete(project_id, move_to=None):
    """Delete a project (its board) in one transaction. With `move_to`, its cards
    and notes join that project first — each card into the column of the same
    name, else the target's first column — and sessions bound to it rebind there,
    so no work item is left on no board. Without it the FKs decide: cards and
    notes keep their rows with project NULL, columns/intake/code index cascade.
    Returns the deleted row, or None if it did not exist."""
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM projects WHERE id = %s FOR UPDATE", (project_id,))
        row = cur.fetchone()
        if not row:
            return None
        if move_to is not None:
            cur.execute(
                "UPDATE cards c SET project_id = %(to)s, column_id = COALESCE("
                "  (SELECT t.id FROM board_columns s JOIN board_columns t "
                "     ON t.project_id = %(to)s AND lower(t.name) = lower(s.name) "
                "   WHERE s.id = c.column_id ORDER BY t.position LIMIT 1),"
                "  (SELECT id FROM board_columns WHERE project_id = %(to)s "
                "   ORDER BY position, id LIMIT 1)) "
                "WHERE c.project_id = %(from)s",
                {"to": move_to, "from": project_id})
            cur.execute("UPDATE notes SET project_id = %s WHERE project_id = %s",
                        (move_to, project_id))
            cur.execute("UPDATE session_meta SET data = data || jsonb_build_object("
                        "'kanbanProject', %s::text) WHERE data->>'kanbanProject' = %s",
                        (str(move_to), str(project_id)))
        else:
            cur.execute("UPDATE session_meta SET data = data - 'kanbanProject' "
                        "WHERE data->>'kanbanProject' = %s", (str(project_id),))
        cur.execute("DELETE FROM projects WHERE id = %s", (project_id,))
    return dict(row)


def project_card_count(project_id):
    with postgres.cursor() as cur:
        cur.execute("SELECT count(*) AS n FROM cards WHERE project_id = %s", (project_id,))
        return cur.fetchone()["n"]


def _norm_cwd(host, cwd):
    """Canonical form of a directory used as a project key. On the local host we
    expand a leading ~ and strip a trailing slash so "~/x", "/home/u/x" and
    "/home/u/x/" don't fork into separate projects. Remote paths are left as-is
    (their home dir isn't ours to expand)."""
    cwd = (cwd or "").rstrip("/")
    if host in (None, "", "local") and cwd.startswith("~"):
        cwd = os.path.expanduser(cwd)
    return cwd or "/"


# Board columns (per project) -------------------------------------------------

def board_columns_list(project_id):
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM board_columns WHERE project_id = %s ORDER BY position, id",
                    (project_id,))
        return [dict(r) for r in cur.fetchall()]


def board_column_names(column_ids):
    """{id: name} for the columns that still exist among `column_ids`."""
    if not column_ids:
        return {}
    with postgres.cursor() as cur:
        cur.execute("SELECT id, name FROM board_columns WHERE id = ANY(%s)", (list(column_ids),))
        return {r["id"]: r["name"] for r in cur.fetchall()}


def board_column_create(project_id, name, position=0):
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO board_columns(project_id, name, position) VALUES(%s,%s,%s) RETURNING *",
            (project_id, name, position),
        )
        return dict(cur.fetchone())


def board_column_ensure(project_id, name, position=-1):
    """The project's column called `name` (case-insensitive), created at
    `position` when the board has none. Idempotent: the name is the contract,
    so a column the owner moved is found, never duplicated. The advisory lock
    makes find-or-create one step: two posts at once cannot both create it."""
    name = name.strip()
    with postgres.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))",
                    (f"board_column:{project_id}:{name.lower()}",))
        cur.execute("SELECT * FROM board_columns WHERE project_id = %s "
                    "AND lower(trim(name)) = lower(%s) ORDER BY id LIMIT 1",
                    (project_id, name))
        row = cur.fetchone()
        if not row:
            cur.execute("INSERT INTO board_columns(project_id, name, position) "
                        "VALUES(%s,%s,%s) RETURNING *", (project_id, name, position))
            row = cur.fetchone()
    return dict(row)


def board_column_update(column_id, **fields):
    allowed = {k: v for k, v in fields.items() if k in ("name", "position") and v is not None}
    if not allowed:
        return board_column_get(column_id)
    sets = ", ".join(f"{k} = %s" for k in allowed)
    with postgres.cursor() as cur:
        cur.execute(f"UPDATE board_columns SET {sets} WHERE id = %s RETURNING *",
                    (*allowed.values(), column_id))
        row = cur.fetchone()
    return dict(row) if row else None


def board_column_get(column_id):
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM board_columns WHERE id = %s", (column_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def board_column_delete(column_id):
    """Delete a column. Cards in it keep existing (column_id FK is ON DELETE
    SET NULL) so no task is lost when its column is removed."""
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM board_columns WHERE id = %s", (column_id,))
        return cur.rowcount > 0


def board_columns_ensure(project_id):
    """Guarantee the default pipeline is present on this project's board.

    Applies the pure orglogic.ensure_pipeline_columns plan: a pipeline-named
    column missing gets created at its canonical position; one present out of
    place gets its position canonicalised (the name is the contract — see
    orglogic.project_columns, which resolves the same way). Custom columns are
    never touched. Idempotent, and called at every server start (init_db) so
    projects created before the decision columns existed converge on the same
    shape as new ones — the pipeline is default everywhere, not opt-in.
    Returns the plan it applied (for tests/inspection)."""
    cols = board_columns_list(project_id)
    plan = orglogic.ensure_pipeline_columns(cols)
    current = {c["id"]: c["position"] for c in cols}
    applied = 0
    for item in plan:
        if item["id"] is None:
            board_column_create(project_id, item["name"], item["position"])
            applied += 1
        elif current.get(item["id"]) != item["position"]:
            board_column_update(item["id"], position=item["position"])
            applied += 1
    return plan


# Cards (the ONLY card store) -------------------------------------------------

# The columns whose name says the owner's call is needed (orchestrator.asks owns the
# rule; db keeps its own copy because asks is pure and cannot import db).
_DECISION_COLUMNS = ("review", "needs-info")
# SQL for "now if column %(col)s is a decision column, else 0": a card's
# queued_since on entering that column.
_QUEUED_ON_ENTRY = ("CASE WHEN (SELECT lower(name) FROM board_columns WHERE id = %(col)s) "
                    "= ANY(%(dcols)s) THEN %(now)s ELSE 0 END")


def card_create(title, body="", column_id=None, project_id=None,
                session_id=None, position=1.0, created_by=""):
    now = postgres.now()
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO cards(title, body, column_id, project_id, session_id, "
            "position, created_by, created_at, updated_at, queued_since) "
            "VALUES(%(title)s,%(body)s,%(col)s,%(project)s,%(session)s,%(pos)s,"
            f"%(by)s,%(now)s,%(now)s,{_QUEUED_ON_ENTRY}) RETURNING *",
            {"title": title, "body": body, "col": column_id, "project": project_id,
             "session": session_id, "pos": position, "by": created_by, "now": now,
             "dcols": list(_DECISION_COLUMNS)},
        )
        return dict(cur.fetchone())


def card_list(session_id=None, project_id=None, column_id=None):
    """All cards, optionally narrowed by any combination of filters (AND). The
    canonical fetch behind every board VIEW; ordering by position is applied in
    orchestrator.orglogic for the pure/testable path."""
    clauses, params = [], []
    if session_id is not None:
        clauses.append("session_id = %s"); params.append(session_id)
    if project_id is not None:
        clauses.append("project_id = %s"); params.append(project_id)
    if column_id is not None:
        clauses.append("column_id = %s"); params.append(column_id)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    with postgres.cursor() as cur:
        cur.execute(f"SELECT * FROM cards{where} ORDER BY position, id", params)
        return [dict(r) for r in cur.fetchall()]


def card_get(card_id):
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM cards WHERE id = %s", (card_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def card_titles(card_ids):
    """{id: title} for the cards that still exist among `card_ids`."""
    if not card_ids:
        return {}
    with postgres.cursor() as cur:
        cur.execute("SELECT id, title FROM cards WHERE id = ANY(%s)", (list(card_ids),))
        return {r["id"]: r["title"] for r in cur.fetchall()}


def card_update(card_id, **fields):
    allowed = ("title", "body", "column_id", "project_id", "session_id", "position")
    sets = {k: v for k, v in fields.items() if k in allowed}
    if not sets:
        return card_get(card_id)
    now = postgres.now()
    sets["updated_at"] = now
    cols = ", ".join(f"{k} = %({k})s" for k in sets)
    if "column_id" in sets:
        # Entering a column restarts the decision wait clock; staying put keeps
        # it (the right-hand column_id is the OLD value in an UPDATE).
        cols += (", queued_since = CASE WHEN column_id IS NOT DISTINCT FROM %(column_id)s "
                 f"THEN queued_since ELSE {_QUEUED_ON_ENTRY} END")
    with postgres.cursor() as cur:
        cur.execute(f"UPDATE cards SET {cols} WHERE id = %(card_id)s RETURNING *",
                    dict(sets, card_id=card_id, col=sets.get("column_id"), now=now,
                         dcols=list(_DECISION_COLUMNS)))
        row = cur.fetchone()
    return dict(row) if row else None


def card_move(card_id, column_id, position):
    return card_update(card_id, column_id=column_id, position=position)


def card_last_move(card_id, seconds):
    """The column this card's most recent column-moving write landed in, if
    that write happened within the last `seconds` — else None.

    Derived from audit_log: every board write is audited AFTER it runs, with the
    full intent as `target`, so `target->'args'->>'column_id'` is where a
    card_move / card_update-with-column actually put the card. The caller
    validates the column against the card's OWN board, so a row from a refused
    cross-board drag or a since-deleted column is ignored upstream, not here.
    (task_done resolves its column at run time, so its audit row carries no
    column_id and is invisible here by construction — see actions' guard.)
    Returns (column_id, created_at) or None."""
    with postgres.cursor() as cur:
        cur.execute(
            "SELECT target->'args'->>'column_id' AS column_id, created_at "
            "FROM audit_log "
            "WHERE action IN ('card_move', 'card_update') "
            "  AND target->'args'->>'card_id' = %s "
            "  AND target->'args'->>'column_id' IS NOT NULL "
            "  AND created_at > %s "
            "ORDER BY id DESC LIMIT 1",
            (str(card_id), postgres.now() - seconds))
        row = cur.fetchone()
    return (row["column_id"], row["created_at"]) if row else None


def card_delete(card_id):
    """Hard-delete a card (a pure work item — no provenance to preserve).
    Returns True if a row was removed."""
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM cards WHERE id = %s", (card_id,))
        return cur.rowcount > 0


# Card comments (the discussion thread on a card) ----------------------------

def card_comment_add(card_id, author, body):
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO card_comments(card_id, author, body, created_at) "
            "VALUES(%s,%s,%s,%s) RETURNING *",
            (card_id, author or "", body, postgres.now()),
        )
        return dict(cur.fetchone())


def card_comment_list(card_id):
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM card_comments WHERE card_id = %s ORDER BY created_at, id",
                    (card_id,))
        return [dict(r) for r in cur.fetchall()]


def card_comment_counts():
    """{card_id: n} over every card that has at least one comment — the badge
    the board lists render without N+1 per-card queries."""
    with postgres.cursor() as cur:
        cur.execute("SELECT card_id, COUNT(*) AS n FROM card_comments GROUP BY card_id")
        return {r["card_id"]: r["n"] for r in cur.fetchall()}


# Card dependencies (A cannot move forward until B is done) ------------------

def card_dep_add(card_id, depends_on, created_by=""):
    """Record the edge `card_id` -> `depends_on`. A card may not depend on
    itself (that blocks itself forever); an existing edge is a no-op (the
    UNIQUE constraint, not a duplicate row). Returns the stored row, or
    {"exists": True} when the edge was already there."""
    if card_id == depends_on:
        return {"error": "a card cannot depend on itself"}
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO card_deps(card_id, depends_on, created_by, created_at) "
            "VALUES(%s,%s,%s,%s) ON CONFLICT (card_id, depends_on) DO NOTHING "
            "RETURNING *",
            (card_id, depends_on, created_by or "", postgres.now()),
        )
        row = cur.fetchone()
        return dict(row) if row else {"exists": True}


def card_dep_remove(card_id, depends_on):
    """Remove the edge; True if a row was deleted."""
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM card_deps WHERE card_id=%s AND depends_on=%s",
                    (card_id, depends_on))
        return cur.rowcount > 0


def card_deps_batch(card_ids):
    """{card_id: [dep, ...]} where dep = {id, title, column_name, done}.
    `done` follows the board's name contract: the dep's column named (case
    insensitive) "Done" — the same rule project_columns resolves by, so the
    web board, a woken session, and the owner's view all agree on what is done."""
    if not card_ids:
        return {}
    with postgres.cursor() as cur:
        cur.execute(
            "SELECT d.card_id, d.depends_on AS id, c.title, bc.name AS column_name "
            "FROM card_deps d "
            "JOIN cards c ON c.id = d.depends_on "
            "LEFT JOIN board_columns bc ON bc.id = c.column_id "
            "WHERE d.card_id = ANY(%s) ORDER BY d.card_id, d.id",
            (list(card_ids),),
        )
        out = {}
        for r in cur.fetchall():
            col = (r.get("column_name") or "").lower()
            out.setdefault(r["card_id"], []).append(
                {"id": r["id"], "title": r.get("title", ""),
                 "column_name": r.get("column_name") or "",
                 "done": col == "done"})
        return out


def card_mark_attention(card_id, by_own_session):
    """Record who last acted on a card, for the board sweep. A FOREIGN actor (the
    owner, another session) stamps `attention_since` = now — the card's session
    has something to read. The card's OWN session acting clears it to 0 — it
    has seen the board. Idempotent per state, so re-stamping an already
    pending card only moves the time forward."""
    with postgres.cursor() as cur:
        cur.execute("UPDATE cards SET attention_since = %s WHERE id = %s",
                    (0 if by_own_session else postgres.now(), card_id))


def cards_awaiting_owner():
    """Open cards parked in a column whose NAME says the owner's call is needed
    (Review, Needs-info), with the column name and `waiting_since`: when the
    card was parked there (queued_since). Comments do not move it, so a
    reworded ask or a reply to the owner's follow-up keeps the card's place.
    The decision queue's fourth source: a card an agent left for the owner is
    a decision exactly like a question or a plan, and it must surface in the
    same one place, not depend on the owner scanning columns."""
    with postgres.cursor() as cur:
        cur.execute(
            "SELECT c.id, c.title, c.session_id, c.project_id, c.updated_at, "
            "c.ask_expires_at, bc.name AS column_name, "
            "coalesce(nullif(c.queued_since, 0), c.updated_at) AS waiting_since, "
            "(SELECT body FROM card_comments cc WHERE cc.card_id = c.id "
            "   AND left(cc.author, 8) = 'session:' "
            "   ORDER BY created_at DESC, id DESC LIMIT 1) AS ask "
            "FROM cards c JOIN board_columns bc ON bc.id = c.column_id "
            "WHERE lower(bc.name) = ANY(%s) "
            "ORDER BY waiting_since, c.id", (list(_DECISION_COLUMNS),))
        return [dict(r) for r in cur.fetchall()]


def card_ask_set(card_id, ask_since, ask_expires_at):
    """Record the card's open ask (orchestrator.asks decides the values)."""
    with postgres.cursor() as cur:
        cur.execute("UPDATE cards SET ask_since = %s, ask_expires_at = %s WHERE id = %s",
                    (ask_since, ask_expires_at, card_id))


def cards_asks_expired(now):
    """Cards still parked in Review/Needs-info whose open ask's deadline has
    passed and whose session has not been told yet (ask_since > 0) — the
    expiry sweep's work list. Each row: card fields + column_name."""
    with postgres.cursor() as cur:
        cur.execute(
            "SELECT c.*, bc.name AS column_name FROM cards c "
            "JOIN board_columns bc ON bc.id = c.column_id "
            "WHERE c.ask_since > 0 AND c.ask_expires_at > 0 "
            "AND c.ask_expires_at <= %s "
            "AND lower(bc.name) IN ('review', 'needs-info') "
            "ORDER BY c.ask_expires_at, c.id", (now,))
        return [dict(r) for r in cur.fetchall()]


def cards_needing_attention():
    """Open cards (not in a Done-named column) whose last board event came from
    someone other than their own session, with that column's name, oldest
    event first. Each row: {card fields..., column_name}. Cards with no
    session cannot be woken and are excluded; the sweep reads only this."""
    with postgres.cursor() as cur:
        cur.execute(
            "SELECT c.*, bc.name AS column_name FROM cards c "
            "LEFT JOIN board_columns bc ON bc.id = c.column_id "
            "WHERE c.attention_since > 0 AND c.session_id IS NOT NULL "
            "AND c.session_id <> '' "
            "AND lower(coalesce(bc.name, '')) <> 'done' "
            "ORDER BY c.attention_since, c.id")
        return [dict(r) for r in cur.fetchall()]
