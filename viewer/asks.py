"""viewer.asks — one open ask per card, and asks that run out of time (card 235).

A card parked in a decision column (Review / Needs-info) is an ASK: an agent
wants the owner's call. Two failures this module exists to stop:

  1. Time-bound asks ("approve before the Nov 1 deadline") stayed in the queue
     after the date passed, so the owner answered a question that no longer
     meant anything. An ask may now carry `expires_at`; once it passes, the
     queue stops showing it and the asking session is told to decide itself or
     re-ask with new facts.
  2. Several asks piled up on one card's thread, so one tap could not answer
     them and the card's column matched none of them. The queue shows only the
     NEWEST ask, and an agent raising a second ask while the first is still
     open is told to split it onto its own card.

The ask's state lives on the card (cards.ask_since, cards.ask_expires_at):
`ask_since` is when the open ask was raised (0 = no open ask), `ask_expires_at`
is its deadline (0 = none). Everything here is PURE — the action handlers read
the card, call these, and write the result — so the rules unit-test without a
database.
"""
from viewer import loops

DECISION_COLUMNS = ("review", "needs-info")

SPLIT_WARNING = ("This card already has an open ask the owner has not answered. "
                 "One card carries one ask: your comment is now the ask the queue "
                 "shows, and the earlier one is no longer in front of the owner. "
                 "If the earlier ask still matters, split this new one onto its "
                 "own card (card_create, then move it to Review).")


def is_decision_column(name):
    """True for a column whose name says the owner's call is needed."""
    return str(name or "").strip().lower() in DECISION_COLUMNS


def parse_expiry(raw, now):
    """An `expires_at` argument → (epoch, error).

    Absent/blank → (None, None): the caller leaves any existing deadline alone.
    Accepts what a one-shot loop's `at` accepts (loops.parse_when): a relative
    offset ("30m", "2h", "1d") or a local ISO time ("2026-11-01 09:00"). A
    deadline already in the past is refused — an ask born expired would vanish
    from the queue before the owner ever saw it."""
    if raw is None or not str(raw).strip():
        return None, None
    when = loops.parse_when(raw, now)
    if when is None:
        return None, ("bad expires_at — use a relative offset (30m, 2h, 1d) or a "
                      "local time (e.g. '2026-11-01 09:00')")
    if when <= now:
        return None, "expires_at is already in the past — give a future time"
    return float(when), None


def is_expired(expires_at, now):
    """A deadline was set and has passed."""
    try:
        e = float(expires_at or 0)
    except (TypeError, ValueError):
        return False
    return 0 < e <= now


def after_move(into_decision, by_agent, expires, now):
    """The card's (ask_since, ask_expires_at) after a column move.

    An agent moving its card INTO Review/Needs-info is raising an ask: it opens
    now, with the deadline it gave (or none). Every other move — out of the
    decision column, or a human's move anywhere — ends whatever ask was open:
    the column is the source of truth, and a card that left it asks nothing."""
    if into_decision and by_agent:
        return float(now), float(expires or 0)
    return 0.0, 0.0


def after_comment(state, by_agent, in_decision, asked_since_open, expires, now):
    """The card's ask state after a comment, and whether it was a second ask.

    `state` is the card's current (ask_since, ask_expires_at).
    `asked_since_open` — a session already commented since the open ask was
    raised, i.e. the open ask's text is already on the thread.
    `expires` — the parsed deadline the comment carries, or None.

    Returns ((ask_since, ask_expires_at), second_ask).

      - a human's comment answers the open ask: it closes (0, 0).
      - outside a decision column a comment asks nothing: state unchanged.
      - an agent comment with no open ask opens one (deadline: given or none).
      - an agent comment on an ask raised by a move but not yet worded is that
        ask's text: it keeps the move's deadline unless it gives a new one.
      - an agent comment when the open ask is already worded is a SECOND ask:
        it becomes the newest ask (its own deadline, or none) and is flagged.
    """
    since, exp = float(state[0] or 0), float(state[1] or 0)
    if not by_agent:
        return (0.0, 0.0), False
    if not in_decision:
        return (since, exp), False
    if since <= 0:
        return (float(now), float(expires or 0)), False
    if not asked_since_open:
        return (since, exp if expires is None else float(expires)), False
    return (float(now), float(expires or 0)), True


def has_open_ask_text(comments, ask_since):
    """A session wrote on the card at or after the open ask was raised."""
    if not ask_since or float(ask_since) <= 0:
        return False
    return any(str(c.get("author") or "").startswith("session:")
               and float(c.get("created_at") or 0) >= float(ask_since)
               for c in comments or [])


def expired_message(card, expires_at):
    """What the asking session is told when its ask runs out of time."""
    from datetime import datetime
    when = datetime.fromtimestamp(float(expires_at)).strftime("%Y-%m-%d %H:%M")
    return (f'Your ask on card {card.get("id")} "{card.get("title") or ""}" expired '
            f"at {when} without an answer from the owner, so it is off the decision "
            "queue. Expired: decide yourself, or re-ask with new facts (a fresh "
            "comment on the card, with a new expires_at if it is still time-bound).")
