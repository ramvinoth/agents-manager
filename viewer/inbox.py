"""viewer.inbox — the owner's and the agents' message ledger, and the delivery
surface for the EXISTING decision system.

Two kinds of rows live in the one table (db.inbox_*):
  message  — free communication: owner to a session, session to the owner,
             session to another session.
  question / plan / approval / card — auto-delivered decision items. These are
             NOT a second decision system: the row's ref_id points at the one
             durable source (pending_questions, pending_plans, the live
             approval registry, the board card) and open-vs-resolved is
             DERIVED from that source at read time (attach_state). Deciding an
             item still goes through the existing race-safe per-session routes
             (/api/chat/question/answer, /api/chat/plan/decide,
             /api/chat/permission/decide, board card moves) — the inbox only
             makes the decision visible, carries its cold-reader context, and
             hands the owner a reply path.

Delivery never fails the thing it is surfacing: every entry point is
exception-safe the way questions.record is — a lost push or a failed wake is
a missed convenience, never a lost question. A skipped (snoozed) item is
never dropped: a lapsed snooze counts as unread again (effective_status), and
re-delivery of a still-open item refreshes the row back to 'sent' unless the
owner snoozed it (db.inbox_create).
"""
import time

from viewer import db

SNOOZE_DEFAULT_S = 3600          # a tap of "later" without a chosen window
SNOOZE_NEXT_TICK_S = 1800        # 30 minutes — the sweep's own cadence

# The ref a decision message carries, by kind. One durable source per kind:
# question/plan rows key on (session, tool_use_id), the approval registry on
# its per-event id, the board on the card id.
REF_FIELD = {"question": "tool_use_id", "plan": "tool_use_id",
             "approval": "id", "card": "card"}


# ---- pure shaping (no db, no clock, no network) ----------------------------

def effective_status(row, now=None):
    """A row's status as the owner sees it right now: a snooze that has
    lapsed reads as 'sent' again — the skipped item resurfaces on the next
    read, which is the whole point of snooze over delete."""
    now = time.time() if now is None else float(now)
    status = row.get("status") or "sent"
    if status == "snoozed" and float(row.get("snoozed_until") or 0) <= now:
        return "sent"
    return status


def decision_ref(item):
    """The 'kind:ref' key of one decision-queue item (decisions.open_decisions
    output) — the same key its inbox row carries as (kind, ref_id). "" when
    the item has no ref."""
    kind = item.get("kind") or ""
    ref = item.get(REF_FIELD.get(kind, ""))
    return f"{kind}:{ref}" if ref else ""


def open_ref_set(open_items):
    """The decision queue's items as a set of 'kind:ref' strings — the match
    key for attach_state."""
    return {k for k in (decision_ref(it) for it in open_items or []) if k}


def attach_state(rows, open_items, now=None):
    """Annotate inbox rows with the state of the decision they carry.
    Message rows get open=None (not a decision); decision rows get open=True
    while their source is still outstanding and open=False once it is gone
    (answered, decided, approved/denied, card moved out of Review/Needs-info).
    Snoozed rows additionally say so, and every row carries its effective
    status. Pure."""
    open_refs = open_ref_set(open_items)
    now = time.time() if now is None else float(now)
    out = []
    for r in rows:
        kind = r.get("kind") or "message"
        item = dict(r)
        if kind in ("question", "plan", "approval", "card"):
            ref = r.get("ref_id") or ""
            item["open"] = bool(ref) and (f"{kind}:{ref}" in open_refs)
        else:
            item["open"] = None
        item["effective_status"] = effective_status(r, now)
        item["snoozed"] = item["effective_status"] == "snoozed"
        out.append(item)
    return out


def attach_snooze(items, ref_rows, now=None):
    """Annotate decision-queue items with their inbox row: `inbox_id` (the
    handle a client snoozes by) and `snoozed_until` (epoch while a snooze is
    live, 0 otherwise — a lapsed snooze is over, exactly as effective_status
    reads it). Items with no inbox row (delivery failed, or a pre-inbox
    decision) get inbox_id 0 and are never snoozed. Pure."""
    now = time.time() if now is None else float(now)
    by_ref = {}
    for r in ref_rows or []:
        by_ref[f"{r.get('kind')}:{r.get('ref_id')}"] = r
    out = []
    for it in items or []:
        item = dict(it)
        row = by_ref.get(decision_ref(item))
        item["inbox_id"] = int(row.get("id") or 0) if row else 0
        item["snoozed_until"] = (float(row.get("snoozed_until") or 0)
                                 if row and effective_status(row, now) == "snoozed" else 0)
        out.append(item)
    return out


def visible_queue(items):
    """The queue a human is shown right now: every open item whose snooze is
    not live. Snoozed items stay open in the source (attach_state still reads
    them open) — they are deferred, not decided — so this is a view, applied
    last, and only on the surfaces a human scans. With the count."""
    shown = [it for it in items or [] if not it.get("snoozed_until")]
    return {"count": len(shown), "decisions": shown}


def action_queue(rows, open_items, now=None):
    """The 'needs your action' view: decision-kind rows that are still open
    and not snoozed, oldest first (waiting time is the only order before a
    human ranks anything — the same rule as the decision queue). With the
    total count, for the '3 of 12' header."""
    rows = attach_state(rows, open_items, now)
    now = time.time() if now is None else float(now)
    items = [r for r in rows if r.get("open") and not r["snoozed"]]
    items.sort(key=lambda r: (float(r.get("created_at") or now), int(r.get("id") or 0)))
    return {"count": len(items), "items": items}


# ---- message bodies (cold-reader standard) ----------------------------------
# The owner reads these on a phone, hours later, with no memory of the
# session. Every body names the sender and the thing decided in one plain
# sentence, puts what is being asked FIRST, then the context (the card
# comment that carries the full context is included verbatim for cards).

def _fmt_question(questions):
    parts = []
    for q in questions or []:
        text = (q.get("question") or q.get("header") or "").strip()
        if not text:
            continue
        parts.append(text if len(parts) else "What I need from you: " + text)
        opts = []
        for o in (q.get("options") or []):
            label = (o.get("label") or "").strip()
            desc = (o.get("description") or "").strip()
            opts.append(f"{label} — {desc}" if desc else label)
        if opts:
            parts.append("Options: " + " | ".join(opts))
    return "\n".join(parts) or "The session has an open question."


def format_question(session_label, questions):
    who = f"from {session_label} " if session_label else ""
    return f"Question {who}(your tap answers it; you can also type a reply):\n\n" + \
        _fmt_question(questions)


def format_plan(session_label, plan):
    who = f"from {session_label} " if session_label else ""
    plan = (plan or "").strip()
    return (f"Plan awaiting your approval {who}— approve and it proceeds, deny "
            f"with feedback and it revises:\n\n{plan[:2000]}")


def format_approval(session_label, tool_name, preview):
    who = f"from {session_label} " if session_label else ""
    return (f"Permission request {who}— allow it to run, deny to stop it:\n\n"
            f"Tool: {tool_name}\n{preview or ''}".strip())


def format_card(card, comment_body=""):
    cid = card.get("id")
    title = card.get("title") or "(untitled)"
    col = card.get("column_name") or "Review"
    lines = [f'Card {cid} "{title}" is in {col} — the call is yours '
             "(move it, or reply below):"]
    if comment_body:
        lines += ["", comment_body]
    return "\n".join(lines)


def last_session_comment(card_id):
    """The card's most recent comment written by a session (the one that
    carries the question to the owner) — None if the owner wrote it last or
    there are no comments. Read-only."""
    try:
        comments = db.card_comment_list(int(card_id))
    except Exception:
        return None
    for c in reversed(comments or []):
        if str(c.get("author") or "").startswith("session:"):
            return (c.get("body") or "").strip()
    return None


def session_project(session_id):
    """The project a session's messages are born into (its board's project —
    the same binding cards get), or None."""
    try:
        meta = db.session_meta_get(session_id) or {}
        pid = meta.get("kanbanProject")
        return int(pid) if pid else None
    except Exception:
        return None


# ---- delivery (all exception-safe by contract) ------------------------------

def _push_owner(title, body, data):
    try:
        from viewer import push
        push.notify_all(title, body[:300], data=data or {})
    except Exception:
        pass


def _label(session_id):
    try:
        from viewer.engine import _push_label
        return _push_label(session_id, "")
    except Exception:
        return session_id[:12]


def deliver_decision(session_id, kind, ref_id, body, push_title=None):
    """Surface one open decision item in the owner's inbox (upsert — the same
    item re-delivered refreshes its context) and push the owner's phones.
    Never raises: a question that became durable must not break on a failed
    push or a failed insert."""
    try:
        label = _label(session_id)
        db.inbox_create("session", str(session_id), "user", "", body,
                        kind=kind, ref_id=ref_id or "",
                        session_id=str(session_id),
                        project_id=session_project(session_id))
        who = label or "An agent session"
        _push_owner(push_title or f"{who} · {kind}",
                    body.replace("\n", " ")[:180],
                    {"session": str(session_id)})
        try:
            db.audit_append(f"session:{session_id}", "inbox_deliver",
                            {"kind": kind, "ref": ref_id or ""}, "delivered")
        except Exception:
            pass
    except Exception:
        pass


def deliver_message(sender_type, sender_id, recipient_type, recipient_id,
                    body, in_reply_to=0, wake=True):
    """Send one free message between the owner and sessions (or between two
    sessions). Persists the row (owned by the sender session when the sender
    is a session, so the chat's lifecycle carries it), then:
      - recipient is a session: wake it — queued into a running turn, or a
        fresh resumed turn with the message as its prompt (best-effort);
      - recipient is the owner: push the phones (a session writing to the
        owner is news; the owner writing to a session is not).
    Returns the row, or None on a fatal failure (which is logged, not raised).
    """
    try:
        # The row's session_id is the session whose MAILBOX holds it: the
        # recipient when a session is the recipient (the message lives and
        # dies with that chat — archive/delete with it), else the sender when
        # the sender is a session (its record of sending to the owner).
        if recipient_type == "session":
            sid = str(recipient_id)
        elif sender_type == "session":
            sid = str(sender_id)
        else:
            sid = ""
        row = db.inbox_create(sender_type, str(sender_id), recipient_type,
                              str(recipient_id),
                              body, kind="message", ref_id="",
                              in_reply_to=int(in_reply_to or 0),
                              session_id=sid,
                              project_id=session_project(sid) if sid else None)
    except Exception as e:
        print(f"[inbox] deliver_message insert failed: {e}", flush=True)
        return None
    try:
        if recipient_type == "session":
            if wake:
                _wake_session(str(recipient_id), f"[inbox] From {_who(sender_type, sender_id)}:\n{body}")
            _push_owner(f"{_who(sender_type, sender_id)} · inbox",
                        body.replace("\n", " ")[:180],
                        {"session": str(recipient_id)})
        elif sender_type == "session":
            _push_owner(f"{_label(sender_id)} · inbox",
                        body.replace("\n", " ")[:180], {})
        db.audit_append(_who(sender_type, sender_id), "inbox_send",
                        {"to": f"{recipient_type}:{recipient_id}",
                         "in_reply_to": int(in_reply_to or 0)}, "sent")
    except Exception:
        pass
    return row


def _who(sender_type, sender_id):
    if sender_type == "user":
        return "You"
    return _label(str(sender_id))


def _wake_session(session_id, prompt):
    """Wake a session with an incoming message: into its running turn's queue
    when a run is live, else a fresh resumed turn on its original host.
    Best-effort — a failed wake means the message sits in its inbox, where
    the session's next run will list it (the inbox is the durable surface)."""
    try:
        from viewer import engine
        with engine.CHAT_LOCK:
            job = engine.CHAT_JOBS.get(session_id)
            running = bool(job and job.get("running"))
            host = (job or {}).get("host", "local")
        if running:
            engine.enqueue_chat(session_id, prompt)
            return
        cwd = "~"
        if host != "local":
            from viewer import remote
            r = remote.remote_resolve(host, session_id)
            cwd = remote.remote_extract_cwd(host, r["path"]) if r.get("path") else "~"
        else:
            from viewer.config import transcript_path
            from viewer import sessions as sessions_mod
            full = transcript_path(session_id)
            if full:
                cwd = sessions_mod.extract_cwd(full) or cwd
        if not engine.start_claude_run(session_id, ["--resume", session_id],
                                      prompt, "acceptEdits", cwd, "", host):
            return  # a run is already in flight — it will read the inbox
    except Exception:
        pass
