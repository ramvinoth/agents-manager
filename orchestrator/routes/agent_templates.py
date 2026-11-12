"""orchestrator.routes.agent_templates — Agent templates: list, create, edit, duplicate, delete, and their plugins/skills/MCP extras."""
from orchestrator import agenttemplates, chatplugins, db
from orchestrator.config import agent_plugin_dir, agent_plugin_names, template_plugin_dir
from orchestrator.engine import plugin_description
from orchestrator.routes import require_human


class AgentTemplatesMixin:
    def _template_viewer(self, req):
        """The account whose agents this caller sees: the human at the app, or
        for an agent session (no human) the install owner it acts for."""
        user = req.principal.get("user")
        return user["id"] if user else db.owner_user_id()

    def _g_agent_templates(self, req):
        """Shared agents + the caller's own, each marked `editable` for this
        human (never for an agent session) so a client never re-derives it."""
        user = req.principal.get("user")
        self.send_json([{**t, "editable": bool(user) and agenttemplates.editable(t, user)}
                        for t in db.agent_templates_list(self._template_viewer(req))])

    def _p_agent_templates(self, req):
        """Create a personal agent, owned by the human making it."""
        if not require_human(self, req):
            return
        body = self.read_body() or {}
        fields, err = agenttemplates.fields_from(body)
        plugins, perr = agenttemplates.plugins_from(body.get("plugins"))
        if err or perr:
            self.send_json({"error": err or perr}, status=400)
            return
        user = req.principal["user"]
        row = db.agent_template_create(fields, user["id"], created_by=user["username"], plugins=plugins)
        self.send_json({"id": row["id"], "template": row})

    def _owned_template(self, req, body):
        """The agent the body's id names, when this human may change it; else
        answers 404/403 itself and returns None."""
        tid = body.get("id")
        template = db.agent_template_get(int(tid)) if str(tid or "").isdigit() else None
        user = req.principal["user"]
        if not template or not agenttemplates.visible(template, user["id"]):
            self.send_json({"error": "Agent not found"}, status=404)
            return None
        if not agenttemplates.editable(template, user):
            self.send_json({"error": "Built-in agents can't be changed; duplicate it to make your own"
                            if template["is_builtin"] else "Only its owner can change this agent"}, status=403)
            return None
        return template

    def _g_agent_template_extras(self, req):
        """What an agent brings beyond its text: the plugin catalog to pick
        from, and the skills and MCP servers saved on the agent itself. No id
        (a new agent's form) answers the catalog alone."""
        catalog = [{"name": n, "description": plugin_description(agent_plugin_dir(n))} for n in agent_plugin_names()]
        tid = (req.query.get("id") or [""])[0]
        if not tid:
            self.send_json({"catalog": catalog, "skills": [], "mcp": []})
            return
        template = db.agent_template_get(int(tid)) if tid.isdigit() else None
        if not template or not agenttemplates.visible(template, self._template_viewer(req)):
            self.send_json({"error": "Agent not found"}, status=404)
            return
        user = req.principal.get("user")
        root = template_plugin_dir(template["id"])
        skills_, mcp = (chatplugins.extras_rows(root, "agent", bool(user) and agenttemplates.editable(template, user))
                        if root else ([], []))
        self.send_json({"catalog": catalog, "skills": skills_, "mcp": mcp})

    def _p_agent_template_extra(self, req):
        """Save or delete one skill or MCP server on an agent (its owner only):
        {id, kind: skill|mcp, name, content | config | from_path, delete}.
        `from_path` copies an existing skill on this machine (its SKILL.md path
        from /api/capabilities) whole. Every new chat from the agent starts
        with a copy; chats already running keep theirs."""
        if not require_human(self, req):
            return
        body = self.read_body() or {}
        if not self._owned_template(req, body):
            return
        kind, name, delete = body.get("kind"), (body.get("name") or "").strip(), bool(body.get("delete"))
        if kind not in ("skill", "mcp"):
            self.send_json({"error": "kind must be skill or mcp"}, status=400)
            return
        try:
            root = chatplugins.agent_root(int(body["id"]), create=not delete)
            if kind == "skill":
                if delete:
                    chatplugins.delete_skill(root, name)
                elif body.get("from_path"):
                    src = self.resolve_skill_path(body["from_path"])
                    if not src:
                        self.send_json({"error": "Skill not found"}, status=404)
                        return
                    chatplugins.copy_skill(root, src)
                else:
                    chatplugins.save_skill(root, name, body.get("content") or "")
            elif delete:
                chatplugins.delete_mcp(root, name)
            else:
                chatplugins.save_mcp(root, name, body.get("config"))
        except chatplugins.ChatPluginError as e:
            self.send_json({"error": str(e)}, status=e.status)
            return
        self.send_json({"saved": True})

    def _p_agent_templates_update(self, req):
        if not require_human(self, req):
            return
        body = self.read_body() or {}
        if not self._owned_template(req, body):
            return
        fields, err = agenttemplates.fields_from(body)
        plugins, perr = agenttemplates.plugins_from(body.get("plugins"))
        if err or perr:
            self.send_json({"error": err or perr}, status=400)
            return
        if plugins is not None:
            db.agent_template_set_plugins(int(body["id"]), plugins)
        self.send_json({"template": db.agent_template_update(int(body["id"]), fields)})

    def _p_agent_templates_duplicate(self, req):
        """A personal, editable copy of any agent this human can see — the way
        to change a builtin. Carries its kept plugins and saved skills/MCP."""
        if not require_human(self, req):
            return
        body = self.read_body() or {}
        tid = body.get("id")
        source = db.agent_template_get(int(tid)) if str(tid or "").isdigit() else None
        user = req.principal["user"]
        if not source or not agenttemplates.visible(source, user["id"]):
            self.send_json({"error": "Agent not found"}, status=404)
            return
        row = db.agent_template_create(agenttemplates.copy_fields(source), user["id"],
                                       created_by=user["username"], plugins=source.get("plugins"))
        chatplugins.copy_template_extras(source["id"], row["id"])
        self.send_json({"id": row["id"], "template": row})

    def _p_agent_templates_delete(self, req):
        if not require_human(self, req):
            return
        body = self.read_body() or {}
        if not self._owned_template(req, body):
            return
        deleted = db.agent_template_delete(int(body["id"]))
        if deleted:
            chatplugins.purge_template(int(body["id"]))
        self.send_json({"deleted": deleted})
