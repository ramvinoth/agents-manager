"""viewer.routes.intake — IntakeMixin: the public door (POST /api/intake/<id>)
and the owner's management routes (/api/org/intake*). See viewer/intake.py."""
from viewer import db, intake

# An intake event is a short message, not an upload.
_MAX_BYTES = 64 * 1024


class IntakeMixin:
    def _p_intake(self, req):
        """The door itself. Public by path (server.PUBLIC_PREFIX): the channel's
        token is the credential, presented as `X-Intake-Token`, `Authorization:
        Bearer`, `?token=` or a `token` body field — so any webhook sender
        works, including ones that can only set a URL."""
        cid = req.path[len("/api/intake/"):].strip("/")
        channel = db.intake_get(cid) if cid else None
        if not channel:
            self.send_json({"error": "no such channel"}, status=404); return
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = -1
        if length < 0 or length > _MAX_BYTES:
            self.send_json({"error": f"body must be at most {_MAX_BYTES} bytes"}, status=413)
            return
        body = self.read_body()
        if body is None:
            self.send_json({"error": "body must be JSON"}, status=400); return
        auth = self.headers.get("Authorization") or ""
        token = (self.headers.get("X-Intake-Token")
                 or (auth[7:] if auth.lower().startswith("bearer ") else "")
                 or (req.query.get("token") or [""])[0]
                 or (body.get("token") if isinstance(body, dict) else ""))
        if not intake.verify(channel, token):
            self.send_json({"error": "bad token"}, status=401); return
        resp, status = intake.deliver(channel, body, "an external sender")
        if status == 200 and resp.get("id"):
            resp = {"ok": True, "card": resp["id"]}
        self.send_json(resp, status=status)

    def _g_org_intake(self, req):
        self.send_json({"channels": [intake.view(c) for c in db.intake_list()]})

    def _p_org_intake(self, req):
        body = self.read_body() or {}
        self._org_send(req, "intake_create", {**body, "created_by": req.principal["actor"]})

    def _p_org_intake_update(self, req):
        self._org_send(req, "intake_update", self.read_body() or {})

    def _p_org_intake_rotate(self, req):
        self._org_send(req, "intake_rotate", self.read_body() or {})

    def _p_org_intake_delete(self, req):
        self._org_send(req, "intake_delete", self.read_body() or {})
