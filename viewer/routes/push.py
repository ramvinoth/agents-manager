"""viewer.routes.push — PushMixin: register/unregister device push tokens.

The mobile app posts its APNs device token here after login so the server can
send background notifications (see viewer/push.py). Registering is gated like
every other API call — the principal is already resolved on req; a token belongs
to a HUMAN account, so an agent's MCP principal (user None) is refused.
"""
from viewer import db


class PushMixin:
    def _p_push_register(self, req):
        u = req.principal.get("user")
        if not u or not u.get("id"):
            self.send_json({"error": "Not signed in"}, status=401)
            return
        body = self.read_body() or {}
        token = (body.get("token") or "").strip()
        # A raw APNs device token is lowercase hex (64+ chars). Be lenient on
        # length (varies) but reject anything non-hex.
        import re
        if not token or not re.fullmatch(r"[0-9a-fA-F]{32,200}", token):
            self.send_json({"error": "Invalid push token"}, status=400)
            return
        try:
            db.add_push_token(
                u["id"], token, body.get("platform") or "ios",
                app_version=body.get("app_version"), app_build=body.get("app_build"),
            )
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)
            return
        self.send_json({"registered": True})

    def _p_push_unregister(self, req):
        # In PUBLIC_API: a device dropping its own token (logout) must succeed
        # even once the session is gone, so there is no principal to read here.
        body = self.read_body() or {}
        token = (body.get("token") or "").strip()
        if token:
            try:
                db.remove_push_token(token)
            except Exception:
                pass
        self.send_json({"unregistered": True})
