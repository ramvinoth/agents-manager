"""viewer.routes.inbox — InboxMixin: the owner's and the agents' message ledger.

The READ side answers directly (like the notes routes); the one WRITE (send)
goes through actions.execute like every other org write — inbox_send is Green
at ic level, so an agent's message runs immediately and the owner gets a push;
a viewer-role human cannot send at all (deny-by-default scope).

Two audiences, one table:
  - the owner (an app principal) sees every message, filtered by session /
    project / kind, plus the live decision queue the ledger delivers — the
    "needs your action" band with its total count;
  - an agent (an mcp principal) sees its own mailbox only: the messages its
    session sent and the ones addressed to it (the row's session_id is the
    mailbox owner — inbox.deliver_message).

Reads derive state, never store it: a decision row is open only while its
durable source is open (inbox.attach_state against the live sources, the same
ones /api/decisions/open reads). Snoozed rows resurface when the snooze lapses.
"""
import time

from viewer import db, decisions, inbox
from viewer.engine import _push_label, pending_approvals_all_public
from viewer import questions


def open_decisions_items():
    """The cross-session decision queue — the SAME sources /api/decisions/open
    reads (durable questions, durable plans, the live approval registry, cards
    in Review/Needs-info), shaped by decisions.open_decisions. The inbox's
    derived open-state and the decision queue must come from one gather, so
    both routes call this."""
    qrows = questions.get_open_all()
    prows = questions.get_open_plan_all()
    arows = pending_approvals_all_public()
    crows = db.cards_awaiting_owner()
    now = time.time()
    labels = {}
    for sid in ({r["session_id"] for r in qrows}
                | {r["session_id"] for r in prows}
                | {r["session"] for r in arows}
                | {r["session_id"] for r in crows if r.get("session_id")}):
        try:
            labels[sid] = _push_label(sid, "")
        except Exception:
            labels[sid] = ""
    return decisions.open_decisions(qrows, prows, arows, labels, now, crows)


class InboxMixin:
    def _g_inbox(self, req):
        """The inbox list view. Filters: session (one chat's mailbox),
        project, kind (message|question|plan|approval|card). A session
        principal is pinned to its own mailbox; an app principal (the owner)
        may filter by anything. Each decision row carries `open` (derived
        from the live sources) and its effective status; the response also
        carries the unread count and — for the owner — the action queue
        (open, non-snoozed decisions, oldest first, with the total)."""
        p = req.principal
        q = req.query
        session = (q.get("session") or [None])[0]
        if p["kind"] == "mcp":
            session = p["session"]  # an agent reads its own mailbox only
        project = (q.get("project") or [None])[0]
        kind = (q.get("kind") or [None])[0]
        unread_only = (q.get("unread_only") or [None])[0] not in (None, "")
        archived = (q.get("archived") or [None])[0] not in (None, "")
        rows = db.inbox_list(session_id=session,
                             project_id=int(project) if project else None,
                             kind=kind, unread_only=unread_only, archived=archived)
        items = open_decisions_items()["decisions"]
        messages = inbox.attach_state(rows, items)
        unread = db.inbox_unread_count(session_id=session,
                                       project_id=int(project) if project else None,
                                       kind=kind)
        out = {"messages": messages, "unread": unread}
        if p["kind"] == "app":
            qview = inbox.action_queue(messages, items)
            out["queue"] = qview
        self.send_json(out)

    def _g_inbox_msg(self, req):
        """One message in full. A session principal may read only the rows in
        its own mailbox; the owner reads any."""
        p = req.principal
        mid = (req.query.get("id") or [None])[0]
        if not mid:
            self.send_json({"error": "id required"}, status=400)
            return
        msg = db.inbox_get(int(mid))
        if not msg:
            self.send_json({"error": "not found"}, status=404)
            return
        if p["kind"] == "mcp" and msg.get("session_id") != p["session"]:
            self.send_json({"error": "not in your inbox"}, status=403)
            return
        items = open_decisions_items()["decisions"]
        self.send_json({"message": inbox.attach_state([msg], items)[0]})

    def _p_inbox_send(self, req):
        """Send a message. The SENDER is stamped from the resolved principal
        (never from the body — an MCP subprocess can write any string it
        likes, and an inbox that can be impersonated is a poisoned ledger).
        `to` is "user" (the owner) or "session:<id>". The handler (actions:
        inbox_send) persists and wakes/pushes; it is Green at ic level."""
        body = self.read_body() or {}
        to = (body.get("to") or "").strip()
        text = (body.get("body") or "").strip()
        if not to or not text:
            self.send_json({"error": "to and body required"}, status=400)
            return
        p = req.principal
        sender = ("session", p["session"]) if p["kind"] == "mcp" else ("user", "")
        self._org_send(req, "inbox_send",
                       {"to": to, "body": text,
                        "in_reply_to": body.get("in_reply_to") or 0,
                        "sender_type": sender[0], "sender_id": sender[1],
                        "created_by": p["actor"]})

    def _p_inbox_read(self, req):
        """Mark a message read. Owner surface only: a session's consumption
        is the wake itself, not a status write."""
        if req.principal["kind"] != "app":
            self.send_json({"error": "not allowed"}, status=403)
            return
        mid = (self.read_body() or {}).get("id")
        row = db.inbox_mark_read(int(mid)) if mid else None
        if not row:
            self.send_json({"error": "not found"}, status=404)
            return
        self.send_json({"ok": True})

    def _p_inbox_snooze(self, req):
        """Skip a decision for a while without losing it: the row goes
        'snoozed' and a lapsed snooze resurfaces as unread (inbox.effective_
        status). Decisions only — a free message is marked read, not skipped.
        Owner surface only."""
        if req.principal["kind"] != "app":
            self.send_json({"error": "not allowed"}, status=403)
            return
        body = self.read_body() or {}
        mid = body.get("id")
        msg = db.inbox_get(int(mid)) if mid else None
        if not msg:
            self.send_json({"error": "not found"}, status=404)
            return
        if (msg.get("kind") or "message") not in ("question", "plan", "approval", "card"):
            self.send_json({"error": "only decision items can be snoozed"}, status=400)
            return
        hours = body.get("hours")
        try:
            hours = float(hours) if hours not in (None, "") else inbox.SNOOZE_DEFAULT_S / 3600
        except (TypeError, ValueError):
            hours = inbox.SNOOZE_DEFAULT_S / 3600
        until = time.time() + max(0.0, min(hours, 24 * 7)) * 3600
        row = db.inbox_snooze(int(mid), until)
        if not row:
            self.send_json({"error": "not found"}, status=404)
            return
        self.send_json({"ok": True, "snoozed_until": until})
