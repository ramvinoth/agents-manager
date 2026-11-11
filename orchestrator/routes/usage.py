"""orchestrator.routes.usage — UsageMixin: the owner's clients report what they touch;
agents and the owner read the hot/dead digest. See orchestrator/usage.py."""
import sys
import time

from orchestrator import db, intake, usage


class UsageMixin:
    def _p_usage(self, req):
        """Append a batch of usage events from a human's client. Only a human
        principal writes usage (an agent clicking nothing has nothing to say),
        and the actor is the resolved principal, never a body field."""
        p = req.principal
        if p["kind"] != "app":
            self.send_json({"error": "not allowed"}, status=403)
            return
        body = self.read_body() or {}
        events, dropped = usage.clean_events(body.get("events"), body.get("client"))
        written = db.ui_events_insert(p["actor"], events)
        cards = self._feedback_to_board(p, [e for e in events if e["kind"] == "feedback"])
        self.send_json({"ok": True, "written": written, "dropped": dropped,
                        **({"cards": cards} if cards else {})})

    def _feedback_to_board(self, p, notes):
        """Hand each feedback note to the feedback intake channel (orchestrator.intake
        .feedback_channel — the owner's pick, else the built-in one): it becomes
        a card in that board's Feedback column, wakes the channel's session if
        it has one, and an agent's reply there reaches the owner as the board's
        comment push. The note is already stored, so a delivery failure is
        logged, never returned as a failed post."""
        if not notes:
            return []
        try:
            channel = intake.feedback_channel()
            if not channel:
                return []
            cards = []
            for e in notes:
                resp, status = intake.deliver(
                    channel,
                    {"title": f"Feedback · {e['surface']}: {e['detail']}",
                     "text": e["detail"], "surface": e["surface"], "client": e["client"]},
                    f"{p['actor']} (in-app feedback, {e['client']} {e['surface']} screen)",
                    human_role=p["human_role"], session_level="", actor=p["actor"],
                    column=intake.FEEDBACK_COLUMN)
                if status == 200 and resp.get("id"):
                    cards.append(resp["id"])
            return cards
        except Exception as ex:
            print(f"[intake] feedback delivery failed: {ex}", file=sys.stderr)
            return []

    def _g_usage_report(self, req):
        """The digest: hot / dead / cold controls, screen opens and the owner's
        feedback notes over the last `days` (default 30)."""
        try:
            days = max(1, min(365, int((req.query.get("days") or ["30"])[0])))
        except ValueError:
            self.send_json({"error": "days must be a number"}, status=400)
            return
        since = time.time() - days * 86400
        self.send_json(usage.report(db.ui_usage_rows(since), db.ui_feedback_list(since), days))
