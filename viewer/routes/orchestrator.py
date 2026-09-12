"""viewer.routes.orchestrator — OrchestratorMixin: the org / Kanban REST API.

Serves the "digital company" (employees, projects, the ONE canonical board + its
filtered views, approvals, audit). Two callers, one set of routes:

- The mobile app / CEO: authenticated by the normal viewer session (cookie/Bearer).
  Acts with the authority of their `users.role`.
- An employee's MCP subprocess: NOT logged in — authenticates with a per-run token
  in the request headers. Its ceiling is the install owner's role.

Both are resolved to ONE principal by server._resolve_principal before any handler
runs. Reads answer directly; every WRITE becomes an `actions.intent` and goes through
`actions.execute`, which owns both gates (responsibility scope + the Green/Red
charter), the approval queue and the audit trail.

That is the whole shape of this module: **handlers here do no policy**. A route reads
the body, names the action, and hands over. The consequence worth stating — because it
is why the previous design was replaced — is that a Red action queues a *serializable
intent*, so approving it later actually runs the thing. Routes cannot drift from the
MCP proxy or the approval path, because none of them carry a second copy of the rules.

Handlers read req.principal. They never re-authenticate.
"""
from viewer import actions, db, orglogic


class OrchestratorMixin:
    # ── the one entry point for every org write ──────────────────────────────
    def _org_run(self, req, action, args):
        """Turn this request into an intent and execute it under the caller's
        authority. Returns (payload, status) for send_json.

        req.principal is always set: the gate (server._gated) 401s every /api/
        request that could not be resolved, so no handler here is reachable
        without one.
        """
        p = req.principal
        return actions.execute(actions.intent(action, args, p["actor"]),
                               p["human_role"], p["session_level"])

    def _org_send(self, req, action, args):
        """_org_run + send_json — the two-line body most write routes reduce to."""
        resp, status = self._org_run(req, action, args)
        self.send_json(resp, status=status)

    # ── employees ────────────────────────────────────────────────────────────
    def _g_org_employees(self, req):
        self.send_json({"employees": db.employee_list()})

    def _p_org_employees(self, req):
        self._org_send(req, "employee_create", self.read_body() or {})

    def _p_org_employees_update(self, req):
        self._org_send(req, "employee_update", self.read_body() or {})

    # ── projects ─────────────────────────────────────────────────────────────
    def _g_org_projects(self, req):
        self.send_json({"projects": db.project_list()})

    def _p_org_projects(self, req):
        body = self.read_body() or {}
        self._org_send(req, "project_create",
                       {**body, "created_by": req.principal["actor"]})

    # ── board + cards (columns are per project) ───────────────────────────────
    def _g_org_board(self, req):
        project = (req.query.get("project") or [None])[0]
        if not project:
            self.send_json({"error": "project required"}, status=400); return
        self.send_json({"columns": db.board_columns_list(int(project))})

    def _p_org_project_for_cwd(self, req):
        """Find-or-create the org project for a (host, cwd) directory and return
        it. The web 'Tasks' entry point calls this on open, so the common case is
        a pure LOOKUP — only the create half needs authority, or a viewer-role
        human could not open an existing board."""
        body = self.read_body() or {}
        host, cwd = body.get("host", "local"), (body.get("cwd") or "").strip()
        if not cwd:
            self.send_json({"error": "cwd required"}, status=400); return
        existing = db.project_get_by_cwd(host, cwd)
        if existing:
            self.send_json(existing); return
        self._org_send(req, "project_ensure",
                       {"host": host, "cwd": cwd, "name": body.get("name", ""),
                        "created_by": req.principal["actor"]})

    def _p_org_columns(self, req):
        body = self.read_body() or {}
        if not body.get("project_id"):
            self.send_json({"error": "project_id required"}, status=400); return
        self._org_send(req, "column_create", body)

    def _p_org_columns_update(self, req):
        self._org_send(req, "column_update", self.read_body() or {})

    def _p_org_columns_delete(self, req):
        self._org_send(req, "column_delete", self.read_body() or {})

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
        self._org_send(req, "card_create",
                       {**body, "created_by": req.principal["actor"]})

    def _p_org_cards_move(self, req):
        self._org_send(req, "card_move", self.read_body() or {})

    def _p_org_cards_assign(self, req):
        self._org_send(req, "card_assign", self.read_body() or {})

    def _p_org_cards_update(self, req):
        self._org_send(req, "card_update", self.read_body() or {})

    def _p_org_cards_delete(self, req):
        self._org_send(req, "card_delete", self.read_body() or {})

    def _p_org_cards_done(self, req):
        self._org_send(req, "task_done", self.read_body() or {})

    # ── approvals + audit (CEO/manager surfaces) ──────────────────────────────
    def _g_org_approvals(self, req):
        self.send_json({"approvals": db.approval_list_open()})

    def _p_org_approvals_resolve(self, req):
        """Resolve an approval and, if approved, RUN what was approved.

        The row's `detail` is the intent that was queued. Re-dispatching it through
        the same execute() is what makes the Red gate a deferral rather than a
        dead end — and it is why no approval kind needs a bespoke branch here.
        The re-dispatch passes an empty session level: the approver acts as a
        human, so self_approves lets the stored intent through instead of queueing
        a second approval for the same act.

        Separation of duties is checked BEFORE resolving, not after: the approval
        must not have been raised by whoever is answering it. Once approvals
        execute, a principal that could resolve its own would escalate to Red and
        then wave itself through — the gate would be decoration.
        """
        body = self.read_body() or {}
        p = req.principal
        pending = db.approval_get(body.get("id"))
        if pending and not orglogic.may_resolve(pending, p["actor"]):
            db.audit_append(p["actor"], "approval_resolve", {"id": pending["id"]},
                            "denied:self_resolve")
            self.send_json({"denied": True,
                            "reason": "an approval cannot be resolved by whoever raised it"},
                           status=403)
            return
        row, status = self._org_run(req, "approval_resolve", body)
        if status != 200 or row.get("error"):
            self.send_json(row, status=status if status != 200 else 404); return
        result = None
        if body.get("resolution", "approved") == "approved" and \
                (row.get("detail") or {}).get("action"):
            result, _ = actions.execute(row["detail"], p["human_role"], "")
        self.send_json({**row, **({"result": result} if result is not None else {})})

    def _g_org_audit(self, req):
        limit = (req.query.get("limit") or ["100"])[0]
        self.send_json({"audit": db.audit_list(limit=int(limit))})

    # ── Harman autonomous-manager config (owner surface) ─────────────────────
    def _g_org_harman(self, req):
        from viewer.orchestrator import get_config
        self.send_json(get_config())

    def _p_org_harman(self, req):
        """Write Harman config. The master switch takes its own path.

        `automation_enabled` is deliberately NOT one of the patch keys below: it is
        its own pair of actions so that resuming can be Red while pausing stays
        cheap. Folding it into the `harman_config` patch would make un-pausing a
        plain `manager` write — and a session running at manager level would be able
        to restore its own supervision.
        """
        body = self.read_body() or {}
        if "automation_enabled" in body:
            self._org_send(req, "automation_resume" if body["automation_enabled"]
                           else "automation_pause", {})
            return
        patch = {}
        if "enabled" in body:
            patch["enabled"] = bool(body["enabled"])
        if "interval" in body:
            patch["interval"] = int(body["interval"])
        if "budget" in body:
            patch["budget"] = int(body["budget"])
        if "projects" in body:
            patch["projects"] = [int(x) for x in (body["projects"] or [])]
        if "default_provider" in body:
            patch["default_provider"] = str(body["default_provider"] or "")
        self._org_send(req, "harman_config", {"patch": patch})

    # ── Organizational learning: an employee/CEO proposes a skill ─────────────
    def _g_org_skills(self, req):
        self.send_json({"skills": db.skill_learned_list()})

    def _p_org_skills_propose(self, req):
        """Propose a learned skill. The proposal is ONE write either way; overlap
        with an existing skill only changes WHICH action it is, and therefore its
        risk class: novel → `skill_propose` (green, lands now); overlapping →
        `skill_promote` (red, queued for the owner, who is agreeing to overwrite
        knowledge the team already relies on). Both run the same handler, so an
        approval replays the write rather than reimplementing it.
        """
        from viewer import skills
        body = self.read_body() or {}
        name = (body.get("name") or "").strip()
        if not skills.valid_name(name):
            self.send_json({"error": "Bad skill name"}, status=400); return
        content = orglogic.build_skill_md(name, body.get("trigger", ""),
                                          body.get("body", ""),
                                          origin_employee=req.principal["actor"])
        overlaps = orglogic.dedupe_skill(name, skills.list_skill_names())
        resp, status = self._org_run(
            req, "skill_promote" if overlaps else "skill_propose",
            {"name": name, "content": content, "card": body.get("from_card"),
             "session": body.get("session")})
        if resp.get("queued"):
            # Queued for review: record the intent in the skill ledger too, so the
            # library shows a pending entry instead of the proposal vanishing until
            # someone opens the approvals list.
            rec = db.skill_learned_record(name, path="", origin_employee=None,
                                          origin_card=body.get("from_card"),
                                          origin_session=body.get("session"),
                                          status="proposed")
            resp = {**resp, "skill": rec["id"]}
        self.send_json(resp, status=status)
