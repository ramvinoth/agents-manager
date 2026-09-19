"""viewer.boardwatch — the pickup side of the board's decision pipeline.

The board is where the owner and the card's session talk: the owner (or a
foreign session) moves a card into a decision state or comments on it, and the
card's OWN session must find out. This module is the only place that turns such
an event into a wake: a ONE-SHOT loop (kind='once') addressed to the card's
session, whose prompt carries the event.

Why a loop row, not a direct spawn: the session is usually BUSY (it is the
agent that owns the card), and the scheduler's busy-defer already does the
right thing — a one-shot whose session is running re-arms itself (+30s) instead
of firing, then fires the moment the session is free, and retires (the row is
deleted; job_runs keeps the audit). Spawning directly would have to re-implement
deferral, busy detection and the fire-once contract.

Coalescing: the wake id is derived from the card id (bw<card id>), so a card
has AT MOST ONE pending wake. Every new event on the same card updates that one
row's prompt + nextRun instead of stacking wakes — the session reads the card's
current state on pickup, so the latest event is all that matters; the earlier
ones are in the card's comment thread, not lost.

Origin is the CAUSE: a human's action (owner at the UI) makes a 'user' wake —
a person asking, which the loop-firing mode 'user' licenses and which the
automation master switch never halts (the 8f19861 contract). A foreign AGENT's
action makes a 'harman' wake — autonomous, so it obeys the mode AND the
switch, exactly like any other harman-origin loop. The wake can never be
harman-origin when a human caused it, and never a self-wake: the caller
(actions.execute) already excludes the card's own session as the actor.
"""
import time

from viewer import db

_WAKE_DELAY = 15  # seconds until the one-shot is due; the scheduler tick (5s) picks it up


def wake_id(card_id):
    """The deterministic loop id of a card's pending wake (one per card)."""
    return f"bw{card_id}"


def schedule_wake(card, event, origin):
    """Queue (or refresh) the one-shot wake that resumes the card's session with
    `event` (e.g. "moved to 'Approved' by user:ram; comment: '…'"). No-op (None)
    for a card with no session to wake. Returns the wake's loop id.

    `origin` must be USER_ORIGIN for a human-caused event and AGENT_ORIGIN for
    an agent-caused one (see module docstring) — callers pass it; this function
    never guesses WHO, because the loop-control mode acts on that fact.
    """
    sid = (card or {}).get("session_id") or ""
    if not sid or not (event or "").strip():
        return None
    lid = wake_id(card["id"])
    now = time.time()
    prompt = (
        f"[board-watch] Card {card['id']} \"{card.get('title', '')}\" — {event.strip()}. "
        "Read the card and its comments (card_comments), then act on what it says: "
        "Approved means go ahead with that work (finish it, then move the card to Done); "
        "Declined means stop that work; a comment is a message from the person who "
        "manages the board. Report back by commenting on the card."
    )
    if db.loop_get(lid):
        # A wake is already pending for this card: replace its payload and
        # re-arm. Never stack — the session reads current state on pickup.
        # `origin` is patched too: the mode filter acts on the LATEST cause, so
        # a coalesced event must never keep a stale one (a human's comment
        # merged into an agent-caused wake would otherwise never fire in
        # 'user' mode — and vice versa in 'harman' mode).
        db.loop_update(lid, {"prompt": prompt, "nextRun": now + _WAKE_DELAY,
                             "kind": "once", "enabled": True, "origin": origin})
    else:
        db.loop_upsert(lid, {
            "session": sid, "path": "", "prompt": prompt,
            "interval": 0, "cron": None, "kind": "once",
            "nextRun": now + _WAKE_DELAY, "runs": 0, "created": now,
            "model": "", "provider": "", "enabled": True, "origin": origin,
        })
    return lid


def cancel_wake(card_id):
    """Drop a card's pending wake (e.g. the card was deleted or its session
    gone). Returns True if a row was removed."""
    return db.loop_delete(wake_id(card_id))
