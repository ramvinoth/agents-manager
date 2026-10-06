"""viewer.routes.usage — UsageMixin: the owner's clients report what they touch;
agents and the owner read the hot/dead digest. See viewer/usage.py."""
import time

from viewer import db, usage


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
        self.send_json({"ok": True, "written": written, "dropped": dropped})

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
