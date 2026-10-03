"""Saved connections, safe model discovery, and server-authoritative AI settings."""
import json
import urllib.error
import urllib.parse
import urllib.request

from viewer import ai, db, providers
from viewer.config import USER_AGENT
from viewer.routes import require_human


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Even same-origin redirects can expose credentials through a later hop.
        return None


def _draft_connection(body):
    previous = providers.get_preset(body.get("id", "")) or {}
    base = body.get("baseUrl", previous.get("baseUrl", ""))
    if not isinstance(base, str):
        raise ValueError("Invalid endpoint")
    base = base.strip().rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Endpoint must be an HTTP(S) URL without credentials, query or fragment")
    action = body.get("apiKeyAction", "replace" if body.get("apiKey") else "keep")
    if action == "keep":
        if previous.get("apiKey") and base != previous.get("baseUrl", "").rstrip("/"):
            raise ValueError("Endpoint changed; explicitly replace or remove the saved key")
        key = previous.get("apiKey", "")
    elif action == "remove":
        key = ""
    elif action == "replace" and isinstance(body.get("apiKey"), str) and body["apiKey"]:
        key = body["apiKey"]
    else:
        raise ValueError("Invalid apiKeyAction or empty replacement key")
    return base, key


class ProvidersMixin:
    def _ai_human(self, req):
        return require_human(self, req)

    def _g_providers(self, req):
        self.send_json({"providers": providers.list_presets()})

    def _g_providers_default(self, req):
        self.send_json({"id": providers.get_default_id()})

    def _p_providers(self, req):
        if not self._ai_human(req):
            return
        body = self.read_body() or {}
        try:
            base, key = _draft_connection(body)
            saved = providers.upsert_preset(body.get("id", ""), body.get("name", ""),
                base, body.get("model", ""), key,
                body.get("contextLimit") if "contextLimit" in body else None,
                body.get("isDefault") if "isDefault" in body else None)
        except (ValueError, TypeError):
            self.send_json({"error": "Invalid connection or credential action; endpoint changes require replacing or removing the key"}, status=400)
            return
        self.send_json(saved)

    def _p_providers_delete(self, req):
        if self._ai_human(req):
            self.send_json({"deleted": providers.delete_preset((self.read_body() or {}).get("id", ""))})

    def _discover_models(self, base, key):
        result = {"models": [], "choices": [], "source": "endpoint", "manualModelId": True}
        headers = {"User-Agent": USER_AGENT}
        if key:
            headers["Authorization"] = "Bearer " + key
        try:
            opener = urllib.request.build_opener(_NoRedirect())
            with opener.open(urllib.request.Request(base + "/v1/models", headers=headers), timeout=15) as response:
                raw = response.read(1024 * 1024 + 1)
                if len(raw) > 1024 * 1024:
                    raise ValueError("Response too large")
                data = json.loads(raw)
            rows = data.get("data") if isinstance(data, dict) else data
            if not isinstance(rows, list):
                raise ValueError("Invalid model response")
            models = sorted({r["id"] for r in rows if isinstance(r, dict) and isinstance(r.get("id"), str) and r["id"]})
            result.update(models=models, choices=[{"id": m, "label": m} for m in models], status="ok" if models else "empty")
        except urllib.error.HTTPError as exc:
            result.update(status="error", error="Endpoint rejected discovery (HTTP %s)" % exc.code)
        except Exception:
            # Do not echo endpoint bodies, URL credentials or exception text.
            result.update(status="error", error="Model discovery failed; check endpoint and credentials")
        self.send_json(result)

    def _g_providers_models(self, req):
        if not self._ai_human(req):
            return
        pid = (req.query.get("id") or [""])[0]
        if not pid and not req.query.get("baseUrl"):
            self.send_json({"models": [], "choices": [], "status": "unsupported", "source": "runner", "manualModelId": True})
            return
        # Legacy web GET probing remains accepted, but new clients use POST.
        body = {"id": pid} if pid else {"baseUrl": req.query["baseUrl"][0], "apiKey": (req.query.get("key") or [""])[0]}
        if pid and not providers.get_preset(pid):
            self.send_json({"error": "Unknown provider"}, status=404)
            return
        try:
            base, key = _draft_connection(body)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=400)
            return
        self._discover_models(base, key)

    def _p_providers_models(self, req):
        if not self._ai_human(req):
            return
        try:
            base, key = _draft_connection(self.read_body() or {})
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=400)
            return
        self._discover_models(base, key)

    def _ai_read(self, req, defaults):
        query = req.query
        sid = (query.get("id") or [""])[0]
        if not defaults and not providers.valid_id(sid):
            self.send_json({"error": "Valid session id required"}, status=400)
            return
        host, agent = (query.get("host") or ["local"])[0], (query.get("agent") or ["claude"])[0]
        meta = None if defaults else db.session_meta_get(sid)
        if meta:
            host, agent = meta.get("aiHost", host), meta.get("aiAgent", agent)
        doc = ai.document(meta, defaults, host, agent)
        pid = (query.get("provider") or [doc["selection"]["provider"]])[0]
        doc["capabilities"] = ai.capabilities(host, agent, pid)
        self.send_json(doc)

    def _ai_write(self, req, defaults):
        if not self._ai_human(req):
            return
        body = self.read_body() or {}
        host, agent = body.get("host", "local"), body.get("agent", "claude")
        sid, revision = body.get("id", ""), body.get("revision")
        try:
            if type(revision) is not int or revision < 0:
                raise ValueError("Nonnegative revision required")
            if not defaults and not providers.valid_id(sid):
                raise ValueError("Valid session id required")
            if not defaults:
                meta = db.session_meta_get(sid) or {}
                host, agent = meta.get("aiHost", host), meta.get("aiAgent", agent)
            selection = ai.validate(body.get("selection"), host, agent)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=400)
            return
        saved = db.ai_defaults_cas(revision, selection) if defaults else db.session_ai_cas(sid, revision, ai.meta_fields(selection))
        if saved is None:
            self.send_json({"error": "AI settings changed; reload before saving"}, status=409)
            return
        doc = {"revision": revision + 1, "selection": selection, "capabilities": ai.capabilities(host, agent, selection["provider"])}
        if defaults:
            doc["configured"] = True
        self.send_json(doc)

    def _g_ai_defaults(self, req):
        self._ai_read(req, True)

    def _p_ai_defaults(self, req):
        self._ai_write(req, True)

    def _g_session_ai(self, req):
        self._ai_read(req, False)

    def _p_session_ai(self, req):
        self._ai_write(req, False)
