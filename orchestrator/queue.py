"""orchestrator.queue — the owner's decision queue: what is waiting on the human,
and how much of it they are shown.

The owner's attention is the scarcest resource in the system. Every decision
costs them energy, so the queue shows only a few items at a time (`cap`,
default 3, set by the owner). The rest are HELD: still open in their durable
source, never dropped, but silent. They get no push and no badge, and they
surface oldest first as the owner decides or snoozes what is in front of
them. An agent raising an ask into a full queue is told so (FULL_WARNING), so
it decides what it can itself instead of piling on.

One module owns this so every surface agrees: the board's decision deck
(/api/decisions/open), the inbox's action queue and badge, and the push on
delivery all ask the same `shown` view.
"""
import sys
import time

from orchestrator import audit, db, decisions, inbox, questions
from orchestrator.engine import push_label, pending_approvals_all_public

DEFAULT_CAP = 3
MAX_CAP = 20
_SETTING = "decision_queue"

FULL_WARNING = ("The owner's decision queue is full: they see {cap} decisions at a time "
                "and {held} more already wait behind them. Yours is held: no push, "
                "not shown until a slot frees. Decide what you can yourself and say "
                "what you chose, fold other questions into the ask already on this "
                "card, and keep working on everything that does not depend on it.")


def cap():
    """How many decisions the owner sees at once. A missing or malformed
    setting reads as the default: the safe direction is a short queue."""
    stored = db.setting_get(_SETTING, {})
    try:
        n = int(stored.get("cap")) if isinstance(stored, dict) else DEFAULT_CAP
    except (TypeError, ValueError):
        n = DEFAULT_CAP
    return min(max(n, 1), MAX_CAP)


def set_cap(n):
    """The owner's choice, 1 to MAX_CAP. Returns the stored value, or raises
    ValueError for anything else."""
    if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= MAX_CAP:
        raise ValueError(f"cap must be a whole number from 1 to {MAX_CAP}")
    db.setting_set(_SETTING, {"cap": n})
    return n


def shown():
    """The queue as the owner sees it now: the first `cap` open, unsnoozed
    items, with how many are held behind them."""
    return inbox.visible_queue(open_items(), cap())


def _place(kind, ref):
    """(admitted, view): is this decision in front of the owner, and the queue
    it was judged against. An item its source does not list yet counts as
    admitted while there is room. If the queue cannot be read it admits, with
    view None: a lost push is worse than an extra one."""
    try:
        view = shown()
    except Exception as e:
        print(f"[queue] unreadable, admitting {kind}:{ref}: {e}", file=sys.stderr)
        return True, None
    refs = [inbox.decision_ref(i) for i in view["decisions"]]
    admitted = f"{kind}:{ref}" in refs or (view["held"] == 0 and len(refs) < view["cap"])
    return admitted, view


def admits(kind, ref):
    """May this decision push the owner? Only while it is in front of them."""
    return _place(kind, ref)[0]


def full_warning(kind, ref):
    """What an agent is told when its ask lands behind a full queue; "" when
    the owner sees it."""
    admitted, view = _place(kind, ref)
    return "" if admitted else FULL_WARNING.format(cap=view["cap"], held=view["held"])


def red_row(approval):
    """An open org approval with the words the queue shows a cold reader:
    the action's plain name, what it touches, why the asker needs it, and
    what approving costs."""
    intent = approval.get("detail") if isinstance(approval.get("detail"), dict) else {}
    action = intent.get("action") or ""
    return dict(approval,
                action_label=audit.action_label(action) if action else "",
                subject=inbox.red_subject(intent),
                risk=inbox.red_risk(intent),
                reason=inbox.red_reason(intent))


def session_red_items(session_id):
    """Open org approvals this one session raised, worded for a cold reader —
    the asking chat's inline Approve/Deny (card 223). Deciding one goes
    through the same /api/org/approvals/resolve as the queue."""
    if not session_id:
        return []
    try:
        mine = [red_row(r) for r in db.approval_list_open()
                if decisions.red_session(r) == session_id]  # word only this chat's
    except Exception as e:
        # The chat status this rides on must still answer (a live run polls
        # it); the Inbox and the board still carry the approval.
        print(f"[chat] open approvals for {session_id} unreadable: {e}", file=sys.stderr)
        return []
    return decisions.session_red(mine, session_id, time.time())


def open_items():
    """The cross-session decision queue — the SAME sources /api/decisions/open
    reads (durable questions, durable plans, the live approval registry, cards
    in Review/Needs-info, open org Red approvals), shaped by decisions.open_decisions and joined to
    each item's inbox row (inbox_id, snoozed_until) so ONE snooze holds on
    every surface. Returns EVERY open item, snoozed included: the inbox's
    derived open-state needs the full set (a snoozed item is deferred, not
    decided); a human-facing queue applies inbox.visible_queue last."""
    qrows = questions.get_open_all()
    prows = questions.get_open_plan_all()
    arows = pending_approvals_all_public()
    crows = db.cards_awaiting_owner()
    rrows = [red_row(r) for r in db.approval_list_open()]
    now = time.time()
    labels = {}
    for sid in ({r["session_id"] for r in qrows}
                | {r["session_id"] for r in prows}
                | {r["session"] for r in arows}
                | {r["session_id"] for r in crows if r.get("session_id")}
                | {(r.get("detail") or {}).get("session") for r in rrows} - {None, ""}):
        try:
            labels[sid] = push_label(sid, "")
        except Exception:
            labels[sid] = ""
    items = decisions.open_decisions(qrows, prows, arows, labels, now, crows, rrows)["decisions"]
    refs = db.inbox_decision_refs()
    # An open org approval with no inbox row (queued before approvals were
    # delivered, or its delivery failed) is delivered now — once: the upsert
    # gives it a row, so it can be postponed like any other item.
    held = {f"{r['kind']}:{r['ref_id']}" for r in refs}
    missing = [r for r in rrows if f"red:{r['id']}" not in held]
    for r in missing:
        inbox.deliver_red(r)
    if missing:
        refs = db.inbox_decision_refs()
    return inbox.attach_snooze(items, refs, now)
