"""viewer.routes.marketplace — MarketplaceMixin: browse and install MCP tools
and skills from viewer.marketplace's vetted sources.

Browsing is open to any principal (an agent may look for a tool it needs);
installing is human-only — an MCP server is code that will run on this
machine, so the owner presses Install. The install body names an entry, never
a command: the config is rebuilt here from the registry's own record.
Scope follows the manual editors: "user"/"global" for every session, or
"project" for one session's folder (its cwd).
"""
import urllib.request

from viewer import marketplace, skills
from viewer.browser import MCP_CDP_CACHE
from viewer.engine import get_host
from viewer.routes import require_human

_UA = {"User-Agent": "harman-viewer", "Accept": "application/json"}


def _fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=_UA), timeout=15) as r:
        return r.read()


def _q(req, name):
    return (req.query.get(name) or [""])[0].strip()


class MarketplaceMixin:
    def _market(self, fn):
        try:
            self.send_json(fn())
        except marketplace.MarketError as e:
            self.send_json({"error": str(e)}, status=e.status)
        except ValueError as e:
            self.send_json({"error": str(e)}, status=400)

    def _g_market_mcp(self, req):
        self._market(lambda: marketplace.mcp_search(_fetch, _q(req, "q"), _q(req, "cursor")))

    def _g_market_skills(self, req):
        q = _q(req, "q").lower()
        self._market(lambda: {"items": [s for s in marketplace.skills_catalog(_fetch)
                                        if not q or q in (s["id"] + " " + s["description"]).lower()]})

    def _project_cwd(self, body):
        cwd = (body.get("cwd") or "").strip()
        if not cwd and body.get("session"):
            cwd = str(self.session_cwd(body["session"]) or "")
        if not cwd:
            raise marketplace.MarketError("Pick a session or folder for a project install.", 404)
        return cwd

    def _p_market_mcp_install(self, req):
        if not require_human(self, req):
            return
        body = self.read_body() or {}

        def run():
            server = marketplace.mcp_lookup(_fetch, (body.get("id") or "").strip())
            cfg = marketplace.mcp_config(server, body.get("values"))
            scope = "project" if body.get("scope") == "project" else "global"
            cwd = self._project_cwd(body) if scope == "project" else ""
            name = marketplace.config_name(server)
            MCP_CDP_CACHE.pop("local", None)
            res = get_host("local").mcp_save(name, scope, cfg, cwd, False)
            if isinstance(res, dict) and res.get("error"):
                raise marketplace.MarketError(res["error"], res.get("status") or 500)
            return {"installed": name, "scope": scope}
        self._market(run)

    def _p_market_skill_install(self, req):
        if not require_human(self, req):
            return
        body = self.read_body() or {}

        def run():
            name = (body.get("id") or "").strip()
            scope = "project" if body.get("scope") == "project" else "user"
            cwd = self._project_cwd(body) if scope == "project" else None
            path = skills.write_bundle(name, marketplace.skill_bundle(_fetch, name), scope=scope, cwd=cwd)
            return {"installed": name, "scope": scope, "path": str(path)}
        self._market(run)
