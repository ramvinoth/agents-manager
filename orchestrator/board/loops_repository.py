"""Scheduled loops and their job-run history."""

from orchestrator.shared import postgres


# Loops (recurring prompts) ---------------------------------------------------
# Moved out of ~/.claude/.viewer-loops.json into Postgres. Per-row CRUD: each
# scheduler edit touches ONE loop, so nothing rewrites the whole set. Rows come
# back in the historical JSON shape (camelCase keys like nextRun) so the routes
# and clients are unchanged.

# JSON key -> SQL column -> default. Explicit (not **row) so a stray client key
# can't inject a column and the name mapping lives in exactly one place.
_LOOP_COLS = (
    ("session", "session", ""), ("path", "path", ""), ("prompt", "prompt", ""),
    ("interval", "interval_sec", 0), ("cron", "cron", None),
    ("nextRun", "next_run", 0), ("runs", "runs", 0), ("lastRun", "last_run", None),
    ("lastRc", "last_rc", None), ("created", "created", 0), ("model", "model", ""),
    ("provider", "provider", ""),
    ("enabled", "enabled", True), ("origin", "origin", "user"),
    ("kind", "kind", "recurring"),
)


def _loop_row(r):
    """A DB row -> the historical loop dict shape (without the id, which callers
    attach as needed)."""
    return {jk: r[col] for jk, col, _ in _LOOP_COLS}


def loop_list(session=None):
    """All loops (optionally only those for one session) as {id: {...}}, ordered
    by creation so the UI list is stable."""
    with postgres.cursor() as cur:
        if session:
            cur.execute("SELECT * FROM loops WHERE session = %s ORDER BY created", (session,))
        else:
            cur.execute("SELECT * FROM loops ORDER BY created")
        return {r["id"]: _loop_row(r) for r in cur.fetchall()}


def loop_get(lid):
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM loops WHERE id = %s", (lid,))
        row = cur.fetchone()
    return _loop_row(row) if row else None


def loop_upsert(lid, entry):
    """Create or fully replace one loop from an entry dict (historical JSON keys).
    Missing keys fall back to their column default."""
    cols = [col for _, col, _ in _LOOP_COLS]
    vals = [entry.get(jk, dflt) for jk, _, dflt in _LOOP_COLS]
    setclause = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols)
    with postgres.cursor() as cur:
        cur.execute(
            f"INSERT INTO loops (id, {', '.join(cols)}) "
            f"VALUES (%s, {', '.join(['%s'] * len(cols))}) "
            f"ON CONFLICT (id) DO UPDATE SET {setclause}",
            (lid, *vals),
        )


def loop_update(lid, fields):
    """Patch only the given JSON keys of one loop. Returns the updated row (or None
    if the id is gone). Used by the scheduler's per-tick nextRun/runs bumps and the
    edit-loop route, so a concurrent edit to a different field isn't clobbered."""
    jk_to_col = {jk: col for jk, col, _ in _LOOP_COLS}
    sets, vals = [], []
    for jk, v in fields.items():
        col = jk_to_col.get(jk)
        if col:
            sets.append(f"{col} = %s")
            vals.append(v)
    if not sets:
        return loop_get(lid)
    with postgres.cursor() as cur:
        cur.execute(f"UPDATE loops SET {', '.join(sets)} WHERE id = %s RETURNING *",
                    (*vals, lid))
        row = cur.fetchone()
    return _loop_row(row) if row else None


def loop_delete(lid):
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM loops WHERE id = %s RETURNING id", (lid,))
        return cur.fetchone() is not None


def loop_delete_for_session(session):
    """Drop every loop tied to a session (called when the session is deleted).
    Returns how many were removed."""
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM loops WHERE session = %s RETURNING id", (session,))
        return len(cur.fetchall())


def loop_delete_prefix(prefix):
    """Drop every loop whose id starts with `prefix` (the % and _ wildcards in
    it are escaped, so it is a literal prefix). For a target whose wakes share
    an id stem but span several rows — a note discussion wakes one row per
    recipient session (nd<note>:<sid>) — so deleting the note must clear them
    all. Returns how many were removed."""
    like = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM loops WHERE id LIKE %s RETURNING id", (like,))
        return len(cur.fetchall())


def loops_due(now, origins=None):
    """Enabled loops whose nextRun has arrived, each as a dict with its id — the
    scheduler's read side. Ordered by nextRun so the earliest-due fire first.

    `origins` gates by WHO scheduled the loop (see the loop_control setting and
    loops.allowed_origins): a collection of allowed origin strings restricts the
    result to those; None means no origin filter (every origin). An EMPTY
    collection returns nothing — 'none' mode fires no loops at all."""
    with postgres.cursor() as cur:
        if origins is None:
            cur.execute(
                "SELECT * FROM loops WHERE enabled = TRUE AND next_run <= %s "
                "ORDER BY next_run", (now,))
        else:
            cur.execute(
                "SELECT * FROM loops WHERE enabled = TRUE AND next_run <= %s "
                "AND origin = ANY(%s) ORDER BY next_run", (now, list(origins)))
        return [dict(_loop_row(r), id=r["id"]) for r in cur.fetchall()]


# Job runs (append-only history) ----------------------------------------------
# One row per loop firing. Distinct from `loops` (the schedule definition): a
# schedule is one row that fires forever; each firing is one job_runs row. This
# is the audit trail — retention-bounded, never unbounded.

def job_run_start(loop_id, session_id, prompt):
    """Record that a loop just fired. Returns the new run's id, which the caller
    hands to job_run_finish when the run completes. Best-effort at the call site:
    a failure to log history must never stop the actual run."""
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO job_runs (loop_id, session_id, prompt, status, started_at) "
            "VALUES (%s, %s, %s, 'running', %s) RETURNING id",
            (loop_id, session_id, prompt, postgres.now()))
        return cur.fetchone()["id"]


def job_runs_abandon_running(detail="server restarted mid-run"):
    """Boot-time reconciliation: a run is finalized by the thread that spawned it,
    so when the server dies (launchd kills the whole process group, children
    included) every row still 'running' belongs to a run that no longer exists
    and would otherwise read as in-flight forever. Called once before the
    scheduler starts — at that moment nothing can legitimately be running.
    Returns the rows closed."""
    with postgres.cursor() as cur:
        cur.execute(
            "UPDATE job_runs SET status = 'error', rc = -1, detail = %s, finished_at = %s "
            "WHERE status = 'running' RETURNING id",
            (detail, postgres.now()))
        return len(cur.fetchall())


def job_run_finish(run_id, rc, detail=""):
    """Finalize a run row: status from the return code (ok/error), rc, a bounded
    detail (stderr tail), and the finish time."""
    if run_id is None:
        return
    status = "ok" if rc == 0 else "error"
    with postgres.cursor() as cur:
        cur.execute(
            "UPDATE job_runs SET status = %s, rc = %s, detail = %s, finished_at = %s "
            "WHERE id = %s",
            (status, rc, (detail or "")[:2000], postgres.now(), run_id))


def job_runs_purge(max_age_days, max_per_loop):
    """Enforce the retention policy on job_runs so history can't overflow. Two
    independent caps, whichever removes a row first:
      • age: drop runs finished more than max_age_days ago (tidiness).
      • count: keep only the newest max_per_loop runs per loop (the real overflow
        guard — a 30s loop is ~2,880 runs/day, so age alone wouldn't bound it).
    Detached runs (loop_id NULL, from a deleted schedule) are aged out by the age
    cap only — they have no loop to count against. Returns the rows removed."""
    removed = 0
    with postgres.cursor() as cur:
        if max_age_days and max_age_days > 0:
            cutoff = postgres.now() - float(max_age_days) * 86400
            # started_at is always set; finished_at may be NULL for a wedged run,
            # so age off the start time (a run older than the window is stale
            # regardless of whether it recorded a finish).
            cur.execute("DELETE FROM job_runs WHERE started_at < %s RETURNING id", (cutoff,))
            removed += len(cur.fetchall())
        if max_per_loop and max_per_loop > 0:
            # Per loop, rank newest-first and delete beyond the cap. Only non-NULL
            # loop_ids: detached runs aren't grouped under a live schedule.
            cur.execute(
                "DELETE FROM job_runs WHERE id IN ("
                "  SELECT id FROM ("
                "    SELECT id, row_number() OVER "
                "      (PARTITION BY loop_id ORDER BY started_at DESC) AS rn"
                "    FROM job_runs WHERE loop_id IS NOT NULL"
                "  ) ranked WHERE rn > %s) RETURNING id",
                (max_per_loop,))
            removed += len(cur.fetchall())
    return removed
