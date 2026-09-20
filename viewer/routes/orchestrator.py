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
                               p["human_role"], p["session_level"],
                               acting_session=p["session"])

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
    def _board_project(self, project=None, session=None):
        """The one board-resolution rule (orglogic.resolve_board_project) over
        this server's data: an explicit project wins, else the session's bound
        project (kanbanProject, set at spawn). The board READ, card CREATE and
        card DETAIL all resolve through here, so a card is born on the board it
        was seen on and its detail screen can never disagree with that board."""
        session_project = ((db.session_meta_get(session) or {}).get("kanbanProject")
                           if session else None)
        return orglogic.resolve_board_project(project, session_project)

    def _g_org_board(self, req):
        project = self._board_project(
            (req.query.get("project") or [None])[0],
            (req.query.get("session") or [None])[0])
        if not project:
            # No resolvable board, said in the client's language (the mobile
            # screen renders this string as-is): a session whose board was never
            # bound, or a view with no context at all.
            session = (req.query.get("session") or [None])[0]
            msg = ("this chat has no board yet — pick a project on the company screen"
                   if session else "a board is per project — pick one on the company screen")
            self.send_json({"error": msg}, status=400); return
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
        counts = db.card_comment_counts()
        deps = db.card_deps_batch([c["id"] for c in cards])
        for c in cards:  # the badge + its dependency state (dual control: the
            c["comment_count"] = counts.get(c["id"], 0)    # same rows the agents
            c["dependencies"] = deps.get(c["id"], [])      # read via MCP)
        self.send_json({"cards": orglogic.order_column(cards)})

    def _p_org_cards(self, req):
        body = self.read_body() or {}
        # A card is born on the board it was seen on: no project named → the
        # session's own bound project (the same rule the board read applies).
        # Without this a card created from a session-filtered board (the mobile
        # passes only `session`) lands with NO project and its detail screen has
        # no columns to move it into — a dead card.
        if not body.get("project_id"):
            project = self._board_project(None, body.get("session"))
            if not project:
                # A card with no board is invisible on every view — refusing it
                # is the same rule as the read ("a card is born on the board it
                # was seen on"), closed at the other end.
                self.send_json(
                    {"error": "a card needs a board — name a project or an existing chat"},
                    status=400); return
            body["project_id"] = project
        self._org_send(req, "card_create",
                       {**body, "created_by": req.principal["actor"]})

    def _g_org_card(self, req):
        """One card with its full comment thread AND its move options — the read
        the card's detail screen (mobile) and editor (web) load before letting
        anyone talk on it. `columns` is composed here, not by the client: the
        card's own project's columns, else (an orphan) its session's bound
        project's — so the detail screen renders exactly the board the card
        can move on, and an empty list means the card truly has no board (the
        client then offers to attach it to a project)."""
        cid = (req.query.get("id") or [None])[0]
        if not cid:
            self.send_json({"error": "id required"}, status=400); return
        card = db.card_get(int(cid))
        if not card:
            self.send_json({"error": "not found"}, status=404); return
        project = self._board_project(card.get("project_id"), card.get("session_id"))
        self.send_json({"card": card, "comments": db.card_comment_list(card["id"]),
                        "dependencies": db.card_deps_batch([card["id"]]).get(card["id"], []),
                        "columns": db.board_columns_list(int(project)) if project else []})

    def _g_org_card_deps(self, req):
        """One card's dependency edges — the read side of the dual control: the
        owner's UI and the agents' MCP read the same rows through the same gate."""
        cid = (req.query.get("card_id") or [None])[0]
        if not cid:
            self.send_json({"error": "card_id required"}, status=400); return
        self.send_json({"dependencies": db.card_deps_batch([int(cid)]).get(int(cid), [])})

    def _g_org_card_comments(self, req):
        """A card's comment thread alone — the agent-side read (MCP card_comments):
        on a [board-watch] wake the session reads its card's thread and answers."""
        cid = (req.query.get("card_id") or [None])[0]
        if not cid:
            self.send_json({"error": "card_id required"}, status=400); return
        self.send_json({"comments": db.card_comment_list(int(cid))})

    def _p_org_card_comment(self, req):
        """Post a comment on a card's thread. The author is stamped from the
        resolved principal, never from the body: an MCP subprocess can write any
        string it likes into its own JSON, and a thread that can be
        impersonated is a poisoned record, not a discussion."""
        body = self.read_body() or {}
        self._org_send(req, "card_comment",
                       {"card_id": body.get("card_id"),
                        "body": body.get("body", ""),
                        "author": req.principal["actor"]})

    def _p_org_card_dep_add(self, req):
        """Add a card→card dependency: the card cannot move forward until its
        dependency reaches a Done column. A blocker is also a statement of why
        the card is stuck — the wake tells the card's session so."""
        body = self.read_body() or {}
        self._org_send(req, "card_dep_add",
                       {"card_id": body.get("card_id"),
                        "depends_on": body.get("depends_on"),
                        "created_by": req.principal["actor"]})

    def _p_org_card_dep_remove(self, req):
        """Remove a dependency edge — can unblock a card; the wake follows."""
        body = self.read_body() or {}
        self._org_send(req, "card_dep_remove",
                       {"card_id": body.get("card_id"),
                        "depends_on": body.get("depends_on")})

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

    # ── Loop control: WHICH origins may fire (owner control panel) ────────────
    def _g_org_loop_control(self, req):
        from viewer.orchestrator import get_loop_control
        self.send_json(get_loop_control())

    def _p_org_loop_control(self, req):
        """Set the loop-firing mode (user/harman/both/none). Manager-scoped,
        green — a de-escalation ('none'/'user') must always be cheap, and licensing
        agent loops only decides WHETHER already-authored loops run."""
        body = self.read_body() or {}
        self._org_send(req, "loop_mode_set", {"mode": body.get("mode", "")})

    # ── System-awareness preamble (owner surface; manager + Red) ──────────────
    # The global preamble prepended to EVERY session's system prompt. Read is open
    # to any resolved caller (a session may want to see how it is being steered);
    # the write is manager-scoped and Red, because rewriting it injects instructions
    # fleet-wide — an agent's edit queues for the owner, the owner's applies now.
    def _g_org_system_preamble(self, req):
        self.send_json({"preamble": db.setting_get("system_preamble", "") or ""})

    def _p_org_system_preamble(self, req):
        body = self.read_body() or {}
        self._org_send(req, "system_preamble_set",
                       {"preamble": body.get("preamble", "")})

    # ── System docs (read-only; open to any resolved caller) ──────────────────
    # The documentation surface an agent reads to understand the system it is a
    # node in: whitelisted design docs plus one synthetic live-status doc. Read
    # only — there is no write path — and all policy is in viewer.docs (the
    # whitelist is the boundary), so these handlers are pure transport.
    def _g_org_docs(self, req):
        from viewer import docs
        self.send_json({"docs": docs.list_docs()})

    def _g_org_docs_read(self, req):
        from viewer import docs
        doc_id = (req.query.get("id") or [""])[0]
        doc = docs.read_doc(doc_id)
        if doc is None:
            self.send_json({"error": "Doc not found"}, status=404)
            return
        self.send_json(doc)

    # ── Agent-scheduled loops (origin='harman', gated) ────────────────────────
    # The AGENT path to scheduling recurring work. The human UI keeps its own
    # ungated loop routes (routes.sessions): a person editing their own schedules
    # is not an org action. These run through the org gate and stamp origin='harman'
    # server-side, and every one is guarded by the self-mutation rail below.
    def _self_mutation_denied(self, req, target_session,
                              what="its own loop",
                              reason="a session may not schedule or edit its own loop"):
        """True (and responds 403) if this request would mutate the very session
        making it. A worker may change OTHER sessions' supervision, never its
        own — the loop that drives it (its schedule) and its permission mode
        (whether its tools are gated): a model asking for its own trust is a
        temptation to a hurried owner-tap, so the request is refused outright;
        the owner grants it himself at the UI. orglogic.mutates_own_session is
        the pure test; the acting session id comes from the resolved principal,
        so a human at the UI (empty acting session) is never caught. `what`/
        `reason` name the object for the audit row and the 403 body."""
        acting = req.principal.get("session") or ""
        if orglogic.mutates_own_session(acting, target_session or ""):
            db.audit_append(req.principal["actor"], "self_mutation",
                            {"session": target_session, "what": what},
                            "denied:self_mutation")
            self.send_json({"denied": True, "reason": reason}, status=403)
            return True
        return False

    def _p_org_loops(self, req):
        """Create a harman-origin loop for a session OTHER than the caller's own.

        The target session travels as `for_session`, NOT `session`: the MCP transport
        mirrors the CALLER's own session id into the body's `session` field as a
        credential, so a target named `session` would always equal the acting session
        and the self-mutation rail would refuse every create. `for_session` is
        untouched by that transport, so the rail compares real values.
        """
        body = self.read_body() or {}
        target = (body.get("for_session") or "").strip()
        if self._self_mutation_denied(req, target):
            return
        self._org_send(req, "loop_create", {
            "session": target, "path": body.get("path", ""),
            "prompt": body.get("prompt", ""), "cron": body.get("cron"),
            "interval": body.get("interval"), "at": body.get("at"),
            "model": body.get("model", ""),
            "provider": body.get("provider", "")})

    def _p_org_loops_update(self, req):
        """Edit a harman-origin loop. The rail resolves the loop's OWN session (not a
        body field) so a caller cannot dodge it by omitting/spoofing the session."""
        body = self.read_body() or {}
        loop = db.loop_get(body.get("id", ""))
        if not loop:
            self.send_json({"error": "not found"}, status=404); return
        if self._self_mutation_denied(req, loop.get("session")):
            return
        self._org_send(req, "loop_update", body)

    def _p_org_loops_delete(self, req):
        body = self.read_body() or {}
        loop = db.loop_get(body.get("id", ""))
        if not loop:
            self.send_json({"error": "not found"}, status=404); return
        if self._self_mutation_denied(req, loop.get("session")):
            return
        self._org_send(req, "loop_delete", {"id": body.get("id", "")})
