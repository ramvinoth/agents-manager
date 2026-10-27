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

A server that signs in with OAuth (an install answers `signin`) is signed in
from the same dialog: /api/market/mcp/signin/* drive viewer.login.MCP_LOGIN
against the scope it was installed at.
"""
import urllib.request

from viewer import chatplugins, marketplace, skills
from viewer.browser import MCP_CDP_CACHE
from viewer.config import CHAT_PLUGIN_NAME
from viewer.engine import get_host
from viewer.login import MCP_LOGIN
from viewer.routes import require_human

_UA = {"User-Agent": "agents-viewer", "Accept": "application/json"}


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

    def _save_mcp(self, scope, body, name, cfg):
        MCP_CDP_CACHE.pop("local", None)
        if scope in ("chat", "agent"):
            return chatplugins.save_mcp(self._extras_root(scope, body), name, cfg)
        cwd = self._project_cwd(body) if scope == "project" else ""
        res = get_host("local").mcp_save(name, scope, cfg, cwd, False)
        if isinstance(res, dict) and res.get("error"):
            raise marketplace.MarketError(res["error"], res.get("status") or 500)

    def _save_skill(self, scope, body, name, files):
        if scope in ("chat", "agent"):
            return chatplugins.install_skill_bundle(self._extras_root(scope, body), name, files)
        cwd = self._project_cwd(body) if scope == "project" else None
        return skills.write_bundle(name, files, scope="user" if scope == "global" else scope, cwd=cwd)

    def _p_market_mcp_install(self, req):
        """A registry server, or a featured plugin (its MCP server plus the
        skills that teach an agent to use it), installed in one press."""
        body = self._install_body(req)
        if body is None:
            return

        def run():
            fid = (body.get("id") or "").strip()
            scope = body.get("scope") if body.get("scope") in ("project", "chat", "agent") else "global"
            if marketplace.featured(fid):
                bundle = marketplace.featured_bundle(_fetch, fid)
                for name, cfg in bundle["mcp"].items():
                    self._save_mcp(scope, body, name, cfg)
                for name, files in bundle["skills"].items():
                    self._save_skill(scope, body, name, files)
                return {"installed": ", ".join(bundle["mcp"]), "scope": scope,
                        "skills": sorted(bundle["skills"]), "signin": sorted(bundle["mcp"])}
            server = marketplace.mcp_lookup(_fetch, fid)
            cfg = marketplace.mcp_config(server, body.get("values"))
            name = marketplace.config_name(server)
            self._save_mcp(scope, body, name, cfg)
            return {"installed": name, "scope": scope}
        self._market(run)

    def _p_market_skill_install(self, req):
        body = self._install_body(req)
        if body is None:
            return

        def run():
            name = (body.get("id") or "").strip()
            scope = body.get("scope") if body.get("scope") in ("project", "chat", "agent") else "user"
            path = self._save_skill(scope, body, name, marketplace.skill_bundle(_fetch, name))
            return {"installed": name, "scope": scope, "path": str(path)}
        self._market(run)

    def _p_market_mcp_signin_start(self, req):
        body = self._install_body(req)
        if body is None:
            return

        def run():
            name = (body.get("name") or "").strip()
            if not name or not name.replace("-", "").replace("_", "").isalnum():
                raise marketplace.MarketError("Name the server to sign in to.", 400)
            scope = body.get("scope")
            if scope in ("chat", "agent"):
                MCP_LOGIN.start(f"plugin:{CHAT_PLUGIN_NAME}:{name}",
                                plugin_dir=self._extras_root(scope, body))
            elif scope == "project":
                MCP_LOGIN.start(name, cwd=self._project_cwd(body), project_server=True)
            else:
                MCP_LOGIN.start(name)
            return MCP_LOGIN.poll()
        self._market(run)

    def _p_market_mcp_signin_submit(self, req):
        if not require_human(self, req):
            return
        ok = MCP_LOGIN.submit((self.read_body() or {}).get("redirect") or "")
        self.send_json(MCP_LOGIN.poll() if ok else
                       {"error": "Paste the whole address from the browser's address bar — it starts with http://localhost and contains code="},
                       status=200 if ok else 400)

    def _p_market_mcp_signin_cancel(self, req):
        if not require_human(self, req):
            return
        MCP_LOGIN.cancel()
        self.send_json(MCP_LOGIN.poll())

    def _g_market_mcp_signin(self, req):
        if require_human(self, req):
            self.send_json(MCP_LOGIN.poll())
