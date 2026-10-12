"""viewer.routes.marketplace — MarketplaceMixin: browse and install MCP tools
and skills from viewer.marketplace's vetted sources.

Browsing is open to any principal (an agent may look for a tool it needs);
installing is human-only — an MCP server is code that will run on this
machine, so the owner presses Install. The install body names an entry, never
a command: the config is rebuilt here from the registry's own record.
Scope follows the manual editors: "user"/"global" for every session,
"project" for one session's folder (its cwd), "chat" for that one chat
(its extras plugin, viewer.chatplugins), or "agent" for an agent template the
caller owns (body.agent; every new chat from it gets a copy).
"""
import urllib.request

from viewer import chatplugins, marketplace, skills
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
        except ValueError as e:   # includes ChatPluginError, which carries its own status
            self.send_json({"error": str(e)}, status=getattr(e, "status", 400))

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

    def _chat_sid(self, body):
        rel = body.get("session") or ""
        if not self.resolve_session_quiet(rel):
            raise marketplace.MarketError("Pick a local chat for a this-chat install.", 404)
        return self.sid_from_path(rel)

    def _install_body(self, req):
        """The install request when this human may make it, else None (answered).
        An agent-scoped install needs the caller to own that agent."""
        if not require_human(self, req):
            return None
        body = self.read_body() or {}
        if body.get("scope") == "agent" and not self._owned_template(req, {"id": body.get("agent")}):
            return None
        return body

    def _extras_root(self, scope, body):
        """The extras folder a chat- or agent-scoped install lands in."""
        if scope == "agent":
            return chatplugins.agent_root(int(body["agent"]))
        return chatplugins.chat_root(self._chat_sid(body))

    def _p_market_mcp_install(self, req):
        body = self._install_body(req)
        if body is None:
            return

        def run():
            server = marketplace.mcp_lookup(_fetch, (body.get("id") or "").strip())
            cfg = marketplace.mcp_config(server, body.get("values"))
            scope = body.get("scope") if body.get("scope") in ("project", "chat", "agent") else "global"
            name = marketplace.config_name(server)
            MCP_CDP_CACHE.pop("local", None)
            if scope in ("chat", "agent"):
                chatplugins.save_mcp(self._extras_root(scope, body), name, cfg)
                return {"installed": name, "scope": scope}
            cwd = self._project_cwd(body) if scope == "project" else ""
            res = get_host("local").mcp_save(name, scope, cfg, cwd, False)
            if isinstance(res, dict) and res.get("error"):
                raise marketplace.MarketError(res["error"], res.get("status") or 500)
            return {"installed": name, "scope": scope}
        self._market(run)

    def _p_market_skill_install(self, req):
        body = self._install_body(req)
        if body is None:
            return

        def run():
            name = (body.get("id") or "").strip()
            scope = body.get("scope") if body.get("scope") in ("project", "chat", "agent") else "user"
            files = marketplace.skill_bundle(_fetch, name)
            if scope in ("chat", "agent"):
                path = chatplugins.install_skill_bundle(self._extras_root(scope, body), name, files)
                return {"installed": name, "scope": scope, "path": str(path)}
            cwd = self._project_cwd(body) if scope == "project" else None
            path = skills.write_bundle(name, files, scope=scope, cwd=cwd)
            return {"installed": name, "scope": scope, "path": str(path)}
        self._market(run)
