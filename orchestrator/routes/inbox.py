"""orchestrator.routes.inbox — InboxMixin: the owner's and the agents' message ledger.

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

from orchestrator import db, inbox, queue


class InboxMixin:
    def _g_inbox(self, req):
        """The inbox list view. Filters: session (one chat's mailbox),
        project, kind (message|question|plan|approval|card|red). A session
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
        unread_only = (q.get("unread_only") or [""])[0].lower() not in ("", "0", "false")
        archived = (q.get("archived") or [None])[0] not in (None, "")
        pid = int(project) if project else None
        items = queue.open_items()
        cap = queue.cap()
        agent = p["kind"] == "mcp"
        unread_rows = db.inbox_list(session_id=session, project_id=pid, kind=kind, unread_only=True,
                                    to_session=session if agent else None)
        # The owner's badge counts what waits on the owner; an agent's count is
        # the mail sent to it that it has not listed yet.
        unread = (len(inbox.unread_for_session(unread_rows, session)) if agent
                  else inbox.unread_count(unread_rows, items, cap=cap))
        if (q.get("count_only") or [None])[0] not in (None, ""):
            # The tab badge polls this from every screen: the number only,
            # not the full list it would throw away.
            self.send_json({"unread": unread})
            return
        # An agent reads its inbox on every wake: newest 20 by default, not the
        # whole history (hundreds of rows → hundreds of KB of context per read).
        default_limit = 20 if p["kind"] == "mcp" else 200
        try:
            limit = max(1, min(200, int((q.get("limit") or [default_limit])[0])))
        except ValueError:
            limit = default_limit
        rows = db.inbox_list(session_id=session, project_id=pid, kind=kind,
                             unread_only=unread_only, archived=archived, limit=limit,
                             to_session=session if unread_only and agent else None)
        messages = inbox.attach_state(rows, items)
        if agent:
            # Listing is the agent's read. This response still shows the rows
            # as 'sent' (new to it); the next wake's unread_only skips them.
            db.inbox_mark_read_many(inbox.unread_for_session(rows, session))
        view = inbox.visible_queue(items, cap)
        # Agents read this before raising an ask: held > 0 means the owner's
        # queue is full and a new ask would wait unseen.
        out = {"messages": messages, "unread": unread,
               "owner_queue": {"cap": cap, "shown": view["count"], "held": view["held"]}}
        if p["kind"] == "app":
            out["queue"] = inbox.action_queue(messages, items, cap=cap)
        self.send_json(out)


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

    def _g_inbox_cap(self, req):
        """How many decisions the owner sees at once (orchestrator.queue). Any
        resolved caller may read it; only the owner may change it."""
        self.send_json({"cap": queue.cap(), "default": queue.DEFAULT_CAP,
                        "max": queue.MAX_CAP})

    def _p_inbox_cap(self, req):
        """Set the owner's decision-queue cap. Owner only: the cap protects
        the owner's attention, so no agent may widen it to get its asks in."""
        p = req.principal or {}
        if p.get("kind") != "app" or (p.get("user") or {}).get("role") != "owner":
            self.send_json({"error": "Only the owner can set the decision queue size"},
                           status=403)
            return
        n = (self.read_body() or {}).get("cap")
        try:
            queue.set_cap(n)
        except ValueError as e:
            self.send_json({"error": str(e)}, status=400)
            return
        db.audit_append(p.get("actor") or "owner", "decision_queue_cap", str(n), "ok")
        self.send_json({"cap": queue.cap(), "default": queue.DEFAULT_CAP,
                        "max": queue.MAX_CAP})

    def _p_inbox_read(self, req):
        """Mark a message read. Owner surface only: a session marks its own
        mail read by listing it (_g_inbox)."""
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
        if (msg.get("kind") or "message") not in inbox.DECISION_KINDS:
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
