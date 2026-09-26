"""viewer.board_wake — the two wake paths the action gate never sees.

Every wake in the system is written through boardwatch.schedule_wake (one
coalesced one-shot per card, origin mirrors the cause). This module only
COMPOSES the event strings for the two event families the action handlers
cannot see — both autonomous, so their wakes are harman-origin, gated by the
loop-control mode AND the automation master switch (a human's own card moves
get user-origin wakes from actions._board_followup instead — a person asking,
never halted):

  SWEEP — a 30-minute safety net for board events the event path missed
          (the card's session was running at trigger time, the viewer
          restarted, ...). It wakes only cards with UNANSWERED foreign
          events: someone other than the card's session moved, commented on
          or edited the card (db.cards_needing_attention, stamped by
          actions._board_followup) and that session has not written to the
          card since. A session's own writes are never news to it — the
          previous "anything on the board changed" trigger woke every open
          card on its own status comments, forever (card 19: five identical
          "still in Review, no decision" comments, each of which was the
          change that caused the next wake). Idle board = zero cost.
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
from viewer.config import CHAT_JOBS, CHAT_LOCK, transcript_path

SWEEP_INTERVAL = 1800     # the 30-minute safety net
_MAX_WAKES_PER_SWEEP = 3  # runaway cap per call
_SETTINGS_KEY = "board_swake_last"   # epoch of the last sweep (settings store)
_CURSOR_KEY = "board_swake_cursor"   # id of the last card the sweep woke (settings store)


def _session_running(session_id):
    """A running session is already awake — waking it would only queue work it
    will pick up on its next idle tick anyway."""
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        return bool(job and job.get("running"))


def _wake(card, event, *, skip):
    """One wake through the single mechanism; skipped for a running session, a
    session on the skip list, or a session with no local transcript (the
    scheduler resolves a path-less wake by transcript — engine.run_loop_iteration
    — so such a wake can only ever end as "did not start"; queuing it would spend
    one of the capped slots and an audit row on nothing). Returns True when a
    wake was scheduled."""
    sid = card.get("session_id")
    if not sid or sid in skip or _session_running(sid) or not transcript_path(sid):
        return False
    if boardwatch.schedule_wake(card, event, loops.AGENT_ORIGIN):
        db.audit_append("boardwake", "board_wake",
                        {"card": card["id"], "session": sid}, "queued")
        return True
    return False


def _rotated(cards, after_id):
    """`cards` re-ordered to start just past card `after_id` (the card the
    previous sweep ended on), so the capped budget walks every pending card
    over successive sweeps instead of re-waking the same first three forever.
    An unknown/absent cursor (first sweep, card deleted) starts from the top."""
    ids = [c["id"] for c in cards]
    if after_id not in ids:
        return cards
    i = ids.index(after_id) + 1
    return cards[i:] + cards[:i]


def _describe(card):
    """The wake's event text: what happened, how long it has waited, where the
    card sits, what blocks it — data for the session, never instructions."""
    waited = int((time.time() - float(card.get("attention_since") or 0)) / 60)
    deps = db.card_deps_batch([card["id"]]).get(card["id"], [])
    dep_txt = ", ".join(
        f'card {d["id"]} "{d["title"]}" ({"done" if d["done"] else "NOT done, in " + (d["column_name"] or "no column")})'
        for d in deps) or "none"
    return (f"board sweep: someone else acted on this card {waited} min ago and you "
            f"have not written to it since; you are in '{card.get('column_name') or ''}'; "
            f"your dependencies: {dep_txt} — read the card and its comments, then act "
            f"or comment your next step")


def sweep():
    """The 30-minute safety net, called from engine.loop_scheduler (the
    existing 5s tick — no new thread). Wakes at most _MAX_WAKES_PER_SWEEP
    sessions whose cards carry an unanswered foreign event; a board where every
    session has answered fires nothing. Round-robins across sweeps (the cursor
    lives in the settings store beside the stamp). Returns the sessions woken."""
    now = time.time()
    last = float(db.setting_get(_SETTINGS_KEY, 0) or 0)
    if now - last < SWEEP_INTERVAL:
        return []
    db.setting_set(_SETTINGS_KEY, now)  # stamp FIRST: a slow pass can't double-fire
    try:
        pending = db.cards_needing_attention()
        if not pending:
            return []
        fired = []
        cursor = db.setting_get(_CURSOR_KEY, None)
        for card in _rotated(pending, cursor):
            if len(fired) >= _MAX_WAKES_PER_SWEEP:
                break
            if _wake(card, _describe(card), skip=set(fired)):
                fired.append(card["session_id"])
                db.setting_set(_CURSOR_KEY, card["id"])
        return fired
    except Exception:
        return []   # a DB error is a missed sweep, not a failed tick


def _open_cards():
    """Cards not in a Done-named column — a Done card's session needs no
    open-question relay. Resolves names by the board's name contract (same
    rule as orglogic.project_columns)."""
    cards = db.card_list()
    if not cards:
        return []
    col_by_id = {}
    for pid in {c.get("project_id") for c in cards if c.get("project_id")}:
        for col in db.board_columns_list(pid):
            col_by_id[col["id"]] = col["name"]
    return [c for c in cards
            if (col_by_id.get(c.get("column_id")) or "").lower() != "done"]


def wake_on_open_question(source_session, summary):
    """A session's open question/plan became durable for the owner: wake the
    sessions that own OPEN cards (never the source — it is the one waiting).
    Bounded to _MAX_WAKES_PER_SWEEP. Best-effort: never raises."""
    try:
        fired = []
        for card in _open_cards():
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
