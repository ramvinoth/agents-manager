"""viewer.board_wake — the two wake paths the action gate never sees.

Every wake in the system is written through boardwatch.schedule_wake (one
coalesced one-shot per card, origin mirrors the cause). This module only
COMPOSES the event strings for the two event families the action handlers
cannot see — both autonomous, so their wakes are harman-origin, gated by the
loop-control mode AND the automation master switch (a human's own card moves
get user-origin wakes from actions._board_followup instead — a person asking,
never halted):

  SWEEP — a 30-minute safety net for board changes the event path missed
          (the card's session was running at trigger time, the viewer
          restarted, ...). It fires only when the board actually changed
          since the last sweep, so an idle board costs nothing — no polling,
          no idle token burn. The last-sweep stamp lives in the settings
          store so it survives a viewer restart, and is set BEFORE the change
          check so a slow pass cannot double-fire on the next tick.
  OPEN QUESTION — when another session's AskUserQuestion / ExitPlanMode
          becomes a durable open question/plan for the owner, wake the
          sessions that own OPEN cards (never the source — it is the one
          waiting, not the one to answer) so one of them can surface it to
          the owner. Bounded: at most _MAX_WAKES_PER_SWEEP wakes per call.

Both entry points are exception-safe: a failure here must never break the
scheduler tick or the question that became durable.
"""
import time

from viewer import db, boardwatch, loops
from viewer.config import CHAT_JOBS, CHAT_LOCK

SWEEP_INTERVAL = 1800     # the 30-minute safety net
_MAX_WAKES_PER_SWEEP = 3  # runaway cap per call
_SETTINGS_KEY = "board_swake_last"   # epoch of the last sweep (settings store)


def _session_running(session_id):
    """A running session is already awake — waking it would only queue work it
    will pick up on its next idle tick anyway."""
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        return bool(job and job.get("running"))


def _open_cards():
    """Cards not in a Done-named column, as (card, column_name) pairs — a Done
    card's session needs no watching. Resolves names by the board's name
    contract (same rule as orglogic.project_columns)."""
    cards = db.card_list()
    if not cards:
        return []
    col_by_id = {}
    for pid in {c.get("project_id") for c in cards if c.get("project_id")}:
        for col in db.board_columns_list(pid):
            col_by_id[col["id"]] = col["name"]
    return [(c, col_by_id.get(c.get("column_id")) or "")
            for c in cards
            if (col_by_id.get(c.get("column_id")) or "").lower() != "done"]


def _wake(card, event, *, skip):
    """One wake through the single mechanism; skipped for a running session or
    a session on the skip list. Returns True when a wake was scheduled."""
    sid = card.get("session_id")
    if not sid or sid in skip or _session_running(sid):
        return False
    if boardwatch.schedule_wake(card, event, loops.AGENT_ORIGIN):
        db.audit_append("boardwake", "board_wake",
                        {"card": card["id"], "session": sid}, "queued")
        return True
    return False


def sweep():
    """The 30-minute safety net, called from engine.loop_scheduler (the
    existing 5s tick — no new thread). Wakes at most _MAX_WAKES_PER_SWEEP
    open-card sessions when the board changed since the last sweep; a clean
    board fires nothing. Returns the sessions woken."""
    now = time.time()
    last = float(db.setting_get(_SETTINGS_KEY, 0) or 0)
    if now - last < SWEEP_INTERVAL:
        return []
    db.setting_set(_SETTINGS_KEY, now)  # stamp FIRST: a slow pass can't double-fire
    try:
        changed, summary = db.board_changed_since(last)
        if not changed:
            return []
        fired = []
        for card, column_name in _open_cards():
            if len(fired) >= _MAX_WAKES_PER_SWEEP:
                break
            deps = db.card_deps_batch([card["id"]]).get(card["id"], [])
            dep_txt = ", ".join(
                f'card {d["id"]} "{d["title"]}" ({"done" if d["done"] else "NOT done, in " + (d["column_name"] or "no column")})'
                for d in deps) or "none"
            if _wake(card, f"board sweep: {summary}; you are in '{column_name}'; "
                           f"your dependencies: {dep_txt} — read the card and "
                           f"its comments, then comment your next step",
                     skip=set(fired)):
                fired.append(card["session_id"])
        return fired
    except Exception:
        return []   # a DB error is a missed sweep, not a failed tick


def wake_on_open_question(source_session, summary):
    """A session's open question/plan became durable for the owner: wake the
    sessions that own OPEN cards (never the source — it is the one waiting).
    Bounded to _MAX_WAKES_PER_SWEEP. Best-effort: never raises."""
    try:
        fired = []
        for card, _column_name in _open_cards():
            if len(fired) >= _MAX_WAKES_PER_SWEEP:
                break
            if _wake(card,
                     f"session {str(source_session)[:12]} has an open question/plan "
                     f"for the owner: {summary[:300]} — surface it to the owner if it "
                     f"concerns your card", skip={source_session, *fired}):
                fired.append(card["session_id"])
        return fired
    except Exception:
        return []
