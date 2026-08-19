"""viewer.routes.capabilities — CapabilitiesMixin route + business methods."""
import os
import re
import time
from pathlib import Path
from urllib.parse import parse_qs
from viewer.config import (
    HEADLESS_OK, VIEWER_HANDLED, load_system_commands,
)
from viewer.adapters import resolve_agent_session
from viewer.browser import (
    MCP_CDP_CACHE,
)
from viewer.codex import codex_capabilities, codex_mcp_save, codex_skill_delete, codex_skill_save
from viewer.engine import (
    codex_session_meta, copilot_session_meta, extract_cwd, frontmatter_description, get_host, scan_command_dir, scan_skill_dir,
)


class CapabilitiesMixin:
    def handle_skill_delete(self):
        body = self.read_body() or {}
        if body.get("agent", "claude") == "codex":
            self.send_host_result(codex_skill_delete(body.get("path", "")))
            return
        p = self.resolve_skill_path(body.get("path", ""))
        if not p or not p.exists():
            self.send_json({"error": "Skill not found"}, status=404)
            return
        if str(p).startswith(str(Path.home() / ".claude" / "plugins")):
            self.send_json({"error": "Plugin skills are read-only"}, status=403)
            return
        trash = Path.home() / ".claude" / ".viewer-trash" / "skills"
        try:
            trash.mkdir(parents=True, exist_ok=True)
            dest = trash / f"{p.parent.name}-{int(time.time())}"
            os.rename(p.parent, dest)
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)
            return
        self.send_json({"deleted": True, "trash": str(dest)})

    def handle_mcp_save(self, delete=False):
        body = self.read_body()
        if body is None:
            self.send_json({"error": "Invalid JSON body"}, status=400)
            return
        name = (body.get("name") or "").strip()
        scope = body.get("scope", "project")
        cfg = body.get("config")
        if not name:
            self.send_json({"error": "Empty server name"}, status=400)
            return
        if not delete and not isinstance(cfg, dict):
            self.send_json({"error": "config must be a JSON object"}, status=400)
            return
        host = body.get("host", "local")
        if body.get("agent", "claude") == "codex" and host == "local":
            MCP_CDP_CACHE.pop(host, None)
            self.send_host_result(codex_mcp_save(name, cfg, delete))
            return
        MCP_CDP_CACHE.pop(host, None)   # config is changing — re-read on next run
        h = get_host(host)
        # Resolve the project cwd on the host: explicit dir from the picker, else
        # the session's own cwd (project scope needs a folder to write .mcp.json).
        cwd = (body.get("cwd") or "").strip()
        if scope == "project" and not cwd and body.get("session"):
            try:
                cwd = h.extract_cwd(body["session"])
            except Exception:
                cwd = ""
        try:
            res = h.mcp_save(name, scope, cfg, cwd, delete)
        except Exception as e:
            self.send_json({"error": f"SSH: {e}"}, status=502)
            return
        self.send_host_result(res)

    # ----- Full-session summary -----

    def _p_skill_save(self, req):
        self.handle_skill_save()

    def _p_skill_delete(self, req):
        self.handle_skill_delete()

    def _g_commands(self, req):
        self.serve_commands(req.raw_query)

    def _p_mcp_delete(self, req):
        self.handle_mcp_save(delete=True)

    def serve_commands(self, query):
        """List available slash commands from every source: project, user,
        plugins, and the CLI's own system commands (researched list)."""
        q = parse_qs(query)
        rel = (q.get("session") or [""])[0]
        cmds = {}
        if rel:
            full = self.resolve_session_quiet(rel)
            if full:
                cwd = Path(extract_cwd(full))
                scan_command_dir(cwd / ".claude" / "commands", "project", cmds)
                scan_skill_dir(cwd / ".claude" / "skills", "project skill", cmds)
        scan_command_dir(Path.home() / ".claude" / "commands", "user", cmds)
        scan_skill_dir(Path.home() / ".claude" / "skills", "user skill", cmds)

        # Plugins: ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
        plugins_root = Path.home() / ".claude" / "plugins" / "cache"
        if plugins_root.is_dir():
            for skill_md in plugins_root.glob("*/*/*/skills/*/SKILL.md"):
                plugin = skill_md.parents[2].parent.name
                name = skill_md.parent.name
                cmds.setdefault(name, {"name": name, "description": frontmatter_description(skill_md),
                                       "source": f"plugin:{plugin}"})
            for cmd_md in plugins_root.glob("*/*/*/commands/*.md"):
                plugin = cmd_md.parents[1].parent.name
                name = f"{plugin}:{cmd_md.stem}"
                cmds.setdefault(name, {"name": name, "description": frontmatter_description(cmd_md),
                                       "source": f"plugin:{plugin}"})

        for name, desc in VIEWER_HANDLED.items():
            cmds[name] = {"name": name, "description": desc, "source": "viewer", "handler": "viewer"}

        for name, desc in load_system_commands().items():
            if name in cmds:
                continue
            entry = {"name": name, "description": desc, "source": "built-in"}
            if name not in HEADLESS_OK:
                entry["interactive"] = True
            cmds[name] = entry

        self.send_json(sorted(cmds.values(), key=lambda c: c["name"]))

    def handle_skill_save(self):
        body = self.read_body()
        if body is None:
            self.send_json({"error": "Invalid JSON body"}, status=400)
            return
        name = (body.get("name") or "").strip()
        scope = body.get("scope", "user")
        content = body.get("content") or ""
        if body.get("agent", "claude") == "codex":
            self.send_host_result(codex_skill_save(name, content))
            return
        if not re.fullmatch(r"[\w-]+", name):
            self.send_json({"error": "Skill name must be letters/digits/dashes/underscores"}, status=400)
            return
        cwd = None
        if scope == "project":
            cwd = self.session_cwd(body.get("session", ""))
            if not cwd:
                self.send_json({"error": "Session not found for project scope"}, status=404)
                return
        try:
            from viewer import skills
            p = skills.write_skill(name, content, scope=scope, cwd=cwd)
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)
            return
        self.send_json({"saved": True, "path": str(p)})

    def session_cwd(self, rel):
        full = self.resolve_session_quiet(rel) if rel else None
        return Path(extract_cwd(full)) if full else None

    def _p_mcp_save(self, req):
        self.handle_mcp_save(delete=False)

    def serve_capabilities(self, query):
        q = parse_qs(query)
        rel = (q.get("session") or [""])[0]
        host = (q.get("host") or ["local"])[0]
        agent = (q.get("agent") or ["claude"])[0]
        # cwd from the picked new-session dir, or the session's own cwd on that
        # host, so project-scoped skills/MCP resolve against the right folder.
        cwd = (q.get("cwd") or [""])[0].strip()
        if agent == "codex" and host == "local":
            if not cwd and rel:
                full = resolve_agent_session("codex", rel)
                if full:
                    cwd = codex_session_meta(full)[1]
            self.send_json(codex_capabilities(cwd))
            return
        if agent == "copilot":
            # Host-aware read of ~/.copilot skills + MCP (local or over SSH). cwd
            # is best-effort: local sessions resolve it, remote falls back to
            # user-level config only.
            from viewer.copilot import copilot_capabilities
            if not cwd and rel and host == "local":
                full = resolve_agent_session("copilot", rel)
                if full:
                    cwd = copilot_session_meta(full)[1]
            self.send_json(copilot_capabilities(host, cwd))
            return
        h = get_host(host)
        if not cwd and rel:
            try:
                cwd = h.extract_cwd(rel)
            except Exception:
                cwd = ""
        try:
            self.send_json(h.capabilities(cwd))
        except Exception as e:
            self.send_json({"error": f"SSH: {e}", "skills": [], "mcp": []}, status=502)

    def resolve_skill_path(self, raw):
        """Only allow paths inside the three known skill roots."""
        try:
            p = Path(raw).resolve()
        except Exception:
            return None
        roots = [Path.home() / ".claude" / "skills",
                 Path.home() / ".claude" / "plugins" / "cache"]
        if p.is_file() and p.name == "SKILL.md":
            # project skills can live anywhere under a project's .claude/skills
            if ".claude/skills" in str(p) or any(str(p).startswith(str(r)) for r in roots):
                return p
        return None

    def _g_skill(self, req):
        p = self.resolve_skill_path((req.query.get("path") or [""])[0])
        if not p or not p.exists():
            self.send_json({"error": "Skill not found"}, status=404)
            return
        try:
            self.send_json({"path": str(p), "content": p.read_text(errors="replace")})
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)

    def _g_capabilities(self, req):
        self.serve_capabilities(req.raw_query)

