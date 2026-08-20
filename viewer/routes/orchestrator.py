"""viewer.routes.orchestrator — OrchestratorMixin: the org / Kanban REST API.

Serves the "digital company" (employees, projects, the ONE canonical board + its
filtered views, approvals, audit). Two callers, one set of routes:

- The mobile app / CEO: authenticated by the normal viewer session (cookie/Bearer,
  enforced by _gated). Acts with manager authority.
- An employee's `kanban` MCP subprocess: NOT logged in — authenticates with a
  per-run kanban token in the body/headers (like /api/chat/permission). Its writes
  are gated by the employee's RESPONSIBILITY level (orglogic.allowed) AND the
  Green/Red charter gate (orglogic.classify_action); an over-scope or Red action is
  not executed — it's queued as an approval for Ram. Every attempt is audited.

Because the MCP paths are in server.PUBLIC_API (so the subprocess can reach them),
each handler does its OWN caller check: current_user() first (app), else validate
the kanban token (MCP).
"""
from viewer import db, orglogic
from viewer.engine import validate_kanban_token


class OrchestratorMixin:
    # ── caller resolution ────────────────────────────────────────────────────
    def _org_caller(self, body):
        """Return (kind, level, actor) for this request.
        kind 'app'  → logged-in user, manager authority.
        kind 'mcp'  → valid kanban token, employee's responsibility level.
        kind None   → unauthenticated (caller should 401)."""
        user = self.current_user()
        if user:
            return "app", "manager", f"user:{user['username']}"
        session = (body or {}).get("session") or self.headers.get("X-Kanban-Session", "")
        token = (body or {}).get("token") or self.headers.get("X-Kanban-Token", "")
        info = validate_kanban_token(session, token) if session and token else None
        if info:
            emp = info.get("employee") or {}
            actor = f"employee:{emp.get('name', emp.get('id', '?'))}"
            return "mcp", info.get("level", "ic"), actor
        return None, None, None

    def _org_do(self, action, level, actor, target, mutate):
        """Apply the two-gate policy for an MCP write, then audit.
        - scope: orglogic.allowed(action, level) — is it within authority?
        - risk:  orglogic.classify_action(action) — Green (do it) vs Red (queue).
        Returns the JSON dict to send. `mutate` is a 0-arg callable performing the
        actual db change (only called when allowed + green)."""
        if not orglogic.allowed(action, level):
            db.audit_append(actor, action, target, "denied:scope")
            return {"denied": True, "reason": f"{level} not authorized for {action}"}, 403
        if orglogic.classify_action(action) == "red":
            ap = db.approval_open(kind="infra", summary=f"{actor}: {action}",
                                  detail={"action": action, "target": target}, created_by=actor)
            db.audit_append(actor, action, target, "queued:red")
            return {"queued": True, "approval": ap["id"]}, 200
        result = mutate()
        db.audit_append(actor, action, target, "done")
        return {"ok": True, "result": result}, 200

    # ── employees ────────────────────────────────────────────────────────────
    def _g_org_employees(self, req):
        if not self.current_user():
            self.send_json({"error": "Unauthorized"}, status=401); return
        self.send_json({"employees": db.employee_list()})

    def _p_org_employees(self, req):
        body = self.read_body() or {}
        kind, level, actor = self._org_caller(body)
        if kind is None:
            self.send_json({"error": "Unauthorized"}, status=401); return
        if kind == "mcp":
            resp, status = self._org_do("employee_create", level, actor,
                                        {"name": body.get("name", "")},
                                        lambda: db.employee_create(
                                            body.get("name", ""), body.get("role", ""),
                                            body.get("provider", ""), body.get("model", ""),
                                            body.get("conv_mode", "chat"), body.get("avatar", "")))
            self.send_json(resp, status=status); return
        emp = db.employee_create(body.get("name", ""), body.get("role", ""),
                                 body.get("provider", ""), body.get("model", ""),
                                 body.get("conv_mode", "chat"), body.get("avatar", ""))
        db.audit_append(actor, "employee_create", {"id": emp["id"]}, "done")
        self.send_json(emp)

    def _p_org_employees_update(self, req):
        body = self.read_body() or {}
        if not self.current_user():
            self.send_json({"error": "Unauthorized"}, status=401); return
        emp = db.employee_update(body.get("id"), **{k: v for k, v in body.items()
                                                    if k in ("name", "role", "provider", "model",
                                                             "conv_mode", "avatar", "status")})
        self.send_json(emp or {"error": "not found"})

    # ── projects ─────────────────────────────────────────────────────────────
    def _g_org_projects(self, req):
        if not self.current_user():
            self.send_json({"error": "Unauthorized"}, status=401); return
        self.send_json({"projects": db.project_list()})

    def _p_org_projects(self, req):
        body = self.read_body() or {}
        kind, level, actor = self._org_caller(body)
        if kind is None:
            self.send_json({"error": "Unauthorized"}, status=401); return
        make = lambda: db.project_create(body.get("name", ""), body.get("description", ""),
                                         body.get("host", "local"), body.get("cwd", ""), actor)
        if kind == "mcp":
            resp, status = self._org_do("project_create", level, actor,
                                        {"name": body.get("name", "")}, make)
            self.send_json(resp, status=status); return
        proj = make()
        db.audit_append(actor, "project_create", {"id": proj["id"]}, "done")
        self.send_json(proj)

    # ── board + cards (columns are per project) ───────────────────────────────
    def _g_org_board(self, req):
        project = (req.query.get("project") or [None])[0]
        if not project:
            self.send_json({"error": "project required"}, status=400); return
        self.send_json({"columns": db.board_columns_list(int(project))})

    def _p_org_project_for_cwd(self, req):
        """Find-or-create the org project for a (host, cwd) directory and return
        it. The web 'Tasks' entry point calls this to resolve which board a
        session-directory maps to. App-authed."""
        body = self.read_body() or {}
        kind, level, actor = self._org_caller(body)
        if kind is None:
            self.send_json({"error": "Unauthorized"}, status=401); return
        cwd = (body.get("cwd") or "").strip()
        if not cwd:
            self.send_json({"error": "cwd required"}, status=400); return
        proj = db.project_ensure(body.get("host", "local"), cwd, body.get("name", ""), actor)
        self.send_json(proj)

    def _p_org_columns(self, req):
        body = self.read_body() or {}
        if not self.current_user():
            self.send_json({"error": "Unauthorized"}, status=401); return
        pid = body.get("project_id")
        if not pid:
            self.send_json({"error": "project_id required"}, status=400); return
        self.send_json(db.board_column_create(pid, body.get("name", ""), body.get("position", 0)))

    def _p_org_columns_update(self, req):
        body = self.read_body() or {}
        if not self.current_user():
            self.send_json({"error": "Unauthorized"}, status=401); return
        row = db.board_column_update(body.get("id"), name=body.get("name"),
                                     position=body.get("position"))
        self.send_json(row or {"error": "not found"})

    def _p_org_columns_delete(self, req):
        body = self.read_body() or {}
        if not self.current_user():
            self.send_json({"error": "Unauthorized"}, status=401); return
        self.send_json({"deleted": db.board_column_delete(body.get("id"))})

    def _g_org_cards(self, req):
        session = (req.query.get("session") or [None])[0]
        project = (req.query.get("project") or [None])[0]
        assignee = (req.query.get("assignee") or [None])[0]
        cards = db.card_list(session_id=session,
                             project_id=int(project) if project else None,
                             assignee=int(assignee) if assignee else None)
        self.send_json({"cards": orglogic.order_column(cards)})

    def _p_org_cards(self, req):
        body = self.read_body() or {}
        kind, level, actor = self._org_caller(body)
        if kind is None:
            self.send_json({"error": "Unauthorized"}, status=401); return
        make = lambda: db.card_create(
            body.get("title", ""), body.get("body", ""), body.get("column_id"),
            body.get("assignee"), body.get("project_id"), body.get("session"),
            body.get("position", 1.0), actor)
        if kind == "mcp":
            resp, status = self._org_do("card_create", level, actor,
                                        {"title": body.get("title", "")}, make)
            self.send_json(resp, status=status); return
        self.send_json(make())

    def _p_org_cards_move(self, req):
        body = self.read_body() or {}
        kind, level, actor = self._org_caller(body)
        if kind is None:
            self.send_json({"error": "Unauthorized"}, status=401); return
        make = lambda: db.card_move(body.get("card_id"), body.get("column_id"),
                                    body.get("position", 1.0))
        if kind == "mcp":
            resp, status = self._org_do("card_move", level, actor,
                                        {"card_id": body.get("card_id")}, make)
            self.send_json(resp, status=status); return
        self.send_json(make() or {"error": "not found"})

    def _p_org_cards_assign(self, req):
        body = self.read_body() or {}
        kind, level, actor = self._org_caller(body)
        if kind is None:
            self.send_json({"error": "Unauthorized"}, status=401); return
        make = lambda: db.card_assign(body.get("card_id"), body.get("assignee"))
        if kind == "mcp":
            resp, status = self._org_do("card_assign", level, actor,
                                        {"card_id": body.get("card_id")}, make)
            self.send_json(resp, status=status); return
        self.send_json(make() or {"error": "not found"})

    def _p_org_cards_update(self, req):
        body = self.read_body() or {}
        kind, level, actor = self._org_caller(body)
        if kind is None:
            self.send_json({"error": "Unauthorized"}, status=401); return
        fields = {k: v for k, v in body.items()
                  if k in ("title", "body", "column_id", "assignee", "project_id", "position")}
        make = lambda: db.card_update(body.get("card_id"), **fields)
        if kind == "mcp":
            resp, status = self._org_do("card_update", level, actor,
                                        {"card_id": body.get("card_id")}, make)
            self.send_json(resp, status=status); return
        self.send_json(make() or {"error": "not found"})

    def _p_org_cards_delete(self, req):
        body = self.read_body() or {}
        kind, level, actor = self._org_caller(body)
        if kind is None:
            self.send_json({"error": "Unauthorized"}, status=401); return
        make = lambda: db.card_delete(body.get("card_id"))
        if kind == "mcp":
            resp, status = self._org_do("card_delete", level, actor,
                                        {"card_id": body.get("card_id")}, make)
            self.send_json(resp, status=status); return
        self.send_json({"deleted": bool(make())})

    def _p_org_cards_done(self, req):
        """Move a card to the Done column (last column by position) of its own
        project's board."""
        body = self.read_body() or {}
        kind, level, actor = self._org_caller(body)
        if kind is None:
            self.send_json({"error": "Unauthorized"}, status=401); return
        card_rows = db.card_list()
        card = next((c for c in card_rows if c["id"] == body.get("card_id")), None)
        cols = db.board_columns_list(card["project_id"]) if card and card.get("project_id") else []
        done_id = cols[-1]["id"] if cols else None
        make = lambda: db.card_move(body.get("card_id"), done_id, body.get("position", 1.0))
        if kind == "mcp":
            resp, status = self._org_do("task_done", level, actor,
                                        {"card_id": body.get("card_id")}, make)
            self.send_json(resp, status=status); return
        self.send_json(make() or {"error": "not found"})

    # ── approvals + audit (CEO/manager surfaces) ──────────────────────────────
    def _g_org_approvals(self, req):
        if not self.current_user():
            self.send_json({"error": "Unauthorized"}, status=401); return
        self.send_json({"approvals": db.approval_list_open()})

    def _p_org_approvals_resolve(self, req):
        body = self.read_body() or {}
        user = self.current_user()
        if not user:
            self.send_json({"error": "Unauthorized"}, status=401); return
        resolution = body.get("resolution", "approved")
        row = db.approval_resolve(body.get("id"), resolution)
        # Approving a 'skill' overlap approval finishes the governed promotion:
        # write the SKILL.md (the CEO OK'd the merge) and flip the ledger to active.
        if row and resolution == "approved" and row.get("kind") == "skill":
            try:
                from viewer import skills
                detail = row.get("detail") or {}
                name, content = detail.get("name"), detail.get("content", "")
                if name:
                    p = skills.write_skill(name, content)
                    for s in db.skill_learned_list(status="proposed"):
                        if s.get("name") == name:
                            db.skill_learned_set_status(s["id"], "active")
                    db.audit_append(f"user:{user['username']}", "skill_promote",
                                    {"name": name, "path": str(p)}, "active")
            except Exception:
                pass
        db.audit_append(f"user:{user['username']}", "approval_resolve",
                        {"id": body.get("id")}, resolution)
        self.send_json(row or {"error": "not found"})

    def _g_org_audit(self, req):
        if not self.current_user():
            self.send_json({"error": "Unauthorized"}, status=401); return
        limit = (req.query.get("limit") or ["100"])[0]
        self.send_json({"audit": db.audit_list(limit=int(limit))})

    # ── Harman autonomous-manager config (CEO only) ──────────────────────────
    def _g_org_harman(self, req):
        if not self.current_user():
            self.send_json({"error": "Unauthorized"}, status=401); return
        from viewer.orchestrator import get_config
        self.send_json(get_config())

    def _p_org_harman(self, req):
        user = self.current_user()
        if not user:
            self.send_json({"error": "Unauthorized"}, status=401); return
        body = self.read_body() or {}
        patch = {}
        if "enabled" in body:
            patch["enabled"] = bool(body["enabled"])
        if "interval" in body:
            patch["interval"] = int(body["interval"])
        if "budget" in body:
            patch["budget"] = int(body["budget"])
        if "projects" in body:
            patch["projects"] = [int(p) for p in (body["projects"] or [])]
        if "default_provider" in body:
            patch["default_provider"] = str(body["default_provider"] or "")
        from viewer.orchestrator import set_config
        cfg = set_config(patch)
        db.audit_append(f"user:{user['username']}", "harman_config", patch, "ok")
        self.send_json(cfg)

    # ── Organizational learning: an employee/CEO proposes a skill ─────────────
    def _g_org_skills(self, req):
        if not self.current_user():
            self.send_json({"error": "Unauthorized"}, status=401); return
        self.send_json({"skills": db.skill_learned_list()})

    def _p_org_skills_propose(self, req):
        """Propose a learned skill. Novel + non-overlapping → promote immediately
        (write SKILL.md to the shared user library + ledger 'active'). Overlaps an
        existing skill → do NOT overwrite; open a 'skill' approval for the CEO to
        decide the merge (ledger 'proposed'). Every attempt audited."""
        body = self.read_body() or {}
        kind, level, actor = self._org_caller(body)
        if kind is None:
            self.send_json({"error": "Unauthorized"}, status=401); return
        from viewer import skills
        name = (body.get("name") or "").strip()
        if not skills.valid_name(name):
            self.send_json({"error": "Bad skill name"}, status=400); return
        trigger = body.get("trigger", "")
        content = orglogic.build_skill_md(name, trigger, body.get("body", ""),
                                          origin_employee=actor)
        origin = {"card": body.get("from_card"), "session": body.get("session")}
        existing = skills.list_skill_names()
        if orglogic.dedupe_skill(name, existing):
            # Overlap → governed: queue an approval, don't overwrite.
            ap = db.approval_open("skill", f"{actor}: promote skill '{name}' (overlaps existing)",
                                  {"name": name, "content": content, **origin}, created_by=actor)
            rec = db.skill_learned_record(name, path="", origin_employee=None,
                                          origin_card=origin.get("card"),
                                          origin_session=origin.get("session"), status="proposed")
            db.audit_append(actor, "skill_propose", {"name": name, "approval": ap["id"]}, "queued")
            self.send_json({"queued": True, "approval": ap["id"], "skill": rec["id"]})
            return
        # Novel → promote now.
        p = skills.write_skill(name, content)
        rec = db.skill_learned_record(name, path=str(p), origin_employee=None,
                                      origin_card=origin.get("card"),
                                      origin_session=origin.get("session"), status="active")
        db.audit_append(actor, "skill_promote", {"name": name, "path": str(p)}, "active")
        self.send_json({"promoted": True, "path": str(p), "skill": rec["id"]})
