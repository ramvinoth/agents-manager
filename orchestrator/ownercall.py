"""Owner call request: the gate for waking the owner with a call.

Pure decision logic (no I/O) so it is unit-tested without a server. The handler
in actions.py feeds it the clock, the caller's level and the ring history, then
acts on the verdict. Calling the owner is the loudest thing an agent can do, so
every rule here errs toward NOT ringing:

  - a reason and a card are required (the call opens call mode on that card);
  - only Workspace (lead) and above may ring; a lower level escalates to the
    session that created it, which asks the same question with its own level;
  - never in the owner's quiet hours (server zone, the owner's zone);
  - a minimum gap between rings and a daily cap.
"""
from datetime import datetime

MIN_LEVEL_TO_RING = "lead"
_RANK = {"ic": 0, "lead": 1, "manager": 2}
AWAKE_FROM_HOUR = 8      # inclusive, owner-local
AWAKE_UNTIL_HOUR = 21    # exclusive, owner-local
MIN_GAP_SECONDS = 2 * 3600
DAILY_CAP = 3
REASON_MIN_CHARS = 20


def decide(now, level, reason, card_id, recent_rings, has_parent):
    """Return {"verdict": "ring"|"escalate"|"refuse", "why": str}.

    now: timezone-aware datetime in the owner's zone. recent_rings: epoch
    seconds of earlier rings. level: the caller's effective level key.
    """
    reason = (reason or "").strip()
    if len(reason) < REASON_MIN_CHARS:
        return _refuse(f"give a real reason (at least {REASON_MIN_CHARS} characters): "
                       "what is blocked and why it cannot wait")
    try:
        if int(card_id) <= 0:
            raise ValueError
    except (TypeError, ValueError):
        return _refuse("card_id is required: the call opens call mode on that card")
    if _RANK.get(level, 0) < _RANK[MIN_LEVEL_TO_RING]:
        if has_parent:
            return {"verdict": "escalate",
                    "why": "your level cannot ring the owner; asking the session that created you"}
        return _refuse("your level cannot ring the owner and no session created you; "
                       "move the card to Needs-info instead")
    if not AWAKE_FROM_HOUR <= now.hour < AWAKE_UNTIL_HOUR:
        return _refuse(f"quiet hours: it is {now.strftime('%-I:%M %p %Z')} for the owner "
                       f"(calls only {_hour(AWAKE_FROM_HOUR)} to {_hour(AWAKE_UNTIL_HOUR)}); "
                       "move the card to Needs-info and wait")
    ts = now.timestamp()
    if recent_rings and ts - max(recent_rings) < MIN_GAP_SECONDS:
        return _refuse("the owner was already called in the last 2 hours; "
                       "comment on the card instead")
    today = now.date()
    todays = [r for r in recent_rings
              if datetime.fromtimestamp(r, now.tzinfo).date() == today]
    if len(todays) >= DAILY_CAP:
        return _refuse(f"daily cap of {DAILY_CAP} calls reached; use the card")
    return {"verdict": "ring", "why": "ok"}


def _refuse(why):
    return {"verdict": "refuse", "why": why}


def _hour(h):
    return datetime(2000, 1, 1, h).strftime("%-I %p")
