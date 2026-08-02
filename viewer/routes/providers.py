"""viewer.routes.providers — ProvidersMixin: custom LLM provider presets.

A provider is a saved OpenAI-compatible endpoint {id, name, baseUrl, model} plus a
secret apiKey. A session opts in by storing the preset id in its session-meta; the
custom runner then proxies that session's turns to the endpoint. These routes let
the app manage presets and populate the model dropdown WITHOUT ever holding the key
(the /models fetch happens server-side).

  GET  /api/providers                 -> [{id,name,baseUrl,model}]  (never apiKey)
  POST /api/providers                 body {id?,name,baseUrl,model,apiKey?} -> saved public preset
  POST /api/providers/delete          body {id} -> {deleted: bool}
  GET  /api/providers/models?id=<preset>            -> {models:[...]}
  GET  /api/providers/models?baseUrl=<url>&key=<k>  -> {models:[...]}  (probe before save)
"""
import json
import urllib.request

from viewer import providers


class ProvidersMixin:
    def _g_providers(self, req):
        self.send_json({"providers": providers.list_presets()})

    def _p_providers(self, req):
        body = self.read_body() or {}
        try:
            saved = providers.upsert_preset(
                body.get("id", ""),
                body.get("name", ""),
                body.get("baseUrl", ""),
                body.get("model", ""),
                # None => keep existing key (edit without re-typing the secret).
                body.get("apiKey") if "apiKey" in body else None,
            )
        except ValueError as e:
            self.send_json({"error": str(e)}, status=400)
            return
        self.send_json(saved)

    def _p_providers_delete(self, req):
        body = self.read_body() or {}
        deleted = providers.delete_preset(body.get("id", ""))
        self.send_json({"deleted": deleted})

    def _g_providers_models(self, req):
        """Fetch the endpoint's /v1/models list server-side so the app can populate
        the model dropdown without ever holding the API key. Accepts either a saved
        preset id, or a baseUrl+key pair to probe before the preset is saved."""
        pid = (req.query.get("id") or [""])[0]
        if pid:
            preset = providers.get_preset(pid)
            if not preset:
                self.send_json({"error": "Unknown provider"}, status=404)
                return
            base_url, api_key = preset.get("baseUrl", ""), preset.get("apiKey", "")
        else:
            base_url = (req.query.get("baseUrl") or [""])[0].strip().rstrip("/")
            api_key = (req.query.get("key") or [""])[0]
        if not base_url:
            self.send_json({"error": "baseUrl required"}, status=400)
            return
        url = base_url + "/v1/models"
        headers = {"User-Agent": "harman-viewer/1.0"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        try:
            reqo = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(reqo, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
        except Exception as e:
            self.send_json({"error": f"Endpoint unreachable: {e}"}, status=502)
            return
        # OpenAI shape: {"data":[{"id":"..."}]}. Be liberal about other shapes.
        rows = data.get("data") if isinstance(data, dict) else data
        models = [r.get("id") for r in rows if isinstance(r, dict) and r.get("id")] if isinstance(rows, list) else []
        self.send_json({"models": models})
