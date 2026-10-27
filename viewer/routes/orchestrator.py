"""viewer.routes.orchestrator — OrchestratorMixin: the org / Kanban REST API.

Serves the "digital company" (projects, the ONE canonical board + its
filtered views, approvals, audit). Two callers, one set of routes:

- The mobile app / CEO: authenticated by the normal viewer session (cookie/Bearer).
  Acts with the authority of their `users.role`.
- An agent session's MCP subprocess: NOT logged in — authenticates with a per-run token
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
import io
import os
import threading
import time
import zipfile

from viewer import actions, codemap, db, discussion, inbox, noteexport, notelinks, orglogic

# One re-index at a time per project: two viewers polling the same map must not
# both parse every changed file.
_map_locks = {}
_map_locks_guard = threading.Lock()


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

    # ── projects ─────────────────────────────────────────────────────────────
    def _g_org_projects(self, req):
        # `missing`: a local project whose folder is gone (moved, deleted, or a
        # row from an old machine) — the rail leaves it out until a chat runs there.
        projects = db.project_list()
        for p in projects:
            p["missing"] = p["host"] == "local" and not os.path.isdir(p["cwd"])
        self.send_json({"projects": projects})

    def _p_org_projects(self, req):
        body = self.read_body() or {}
        self._org_send(req, "project_create",
                       {**body, "created_by": req.principal["actor"]})

    def _p_org_projects_delete(self, req):
        self._org_send(req, "project_delete", self.read_body() or {})

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
        cards = db.card_list(session_id=session,
                             project_id=int(project) if project else None)
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

    # ── notes (the knowledge ledger; scoped like cards) ───────────────────────
    def _g_org_notes(self, req):
        """Notes as a filtered VIEW, the board's rule applied to knowledge: a
        session's notes, a project's notes, or (no filter) everything the caller
        can see. `archived=1` opens the shelf a chat's archive put them on."""
        session = (req.query.get("session") or [None])[0]
        project = (req.query.get("project") or [None])[0]
        archived = (req.query.get("archived") or ["0"])[0] in ("1", "true")
        notes = db.note_list(session_id=session, project_id=int(project) if project else None,
                             archived=archived)
        # Each row carries its discussion's size and last activity, so a list
        # can show "3 replies · active 2h ago" without a call per note.
        stats = db.note_comment_stats()
        for n in notes:
            n.update(stats.get(n["id"], {"replies": 0, "last_reply_at": None}))
        self.send_json({"notes": notes})

    def _g_org_note(self, req):
        nid = (req.query.get("id") or [None])[0]
        if not nid:
            self.send_json({"error": "id required"}, status=400); return
        note = db.note_get(int(nid))
        if not note:
            self.send_json({"error": "not found"}, status=404); return
        self.send_json({"note": note})

    def _note_corpus(self, req):
        """Live + archived notes of the requested project (or all of them) —
        what links resolve against. Archived notes still answer to a link."""
        project = (req.query.get("project") or [None])[0]
        pid = int(project) if project else None
        return [n for shelf in (False, True) for n in db.note_list(project_id=pid, archived=shelf)]

    def _g_org_notes_graph(self, req):
        """The linked-notes graph: nodes, [[link]] edges with the line they sit
        on, ghost targets (linked, not written yet), tag counts, and the title
        index clients resolve [[links]] with. Pass id= for one note's view:
        just its backlinks and outgoing links."""
        g = notelinks.graph(self._note_corpus(req))
        nid = (req.query.get("id") or [None])[0]
        if nid:
            nid = int(nid)
            titles = {n["id"]: n for n in g["nodes"]}
            g = {"backlinks": [{**e, "title": titles[e["source"]]["title"]}
                               for e in g["edges"] if e["target"] == nid and e["source"] != nid],
                 "links": [{**e, "title": titles[e["target"]]["title"]}
                           for e in g["edges"] if e["source"] == nid],
                 "ghosts": [x for x in g["ghosts"] if nid in x["from"]],
                 "tags": g["tags"], "index": g["index"]}
        self.send_json(g)

    def _g_org_notes_export(self, req):
        """The notes as an Obsidian vault (zip of .md files with frontmatter) —
        the owner's knowledge is never locked in this app."""
        notes = self._note_corpus(req)
        names = {p["id"]: p["name"] for p in db.project_list()}
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for path, text in notelinks.vault(notes, names).items():
                z.writestr("Manager Notes/" + path, text)
        project = (req.query.get("project") or [None])[0]
        label = names.get(int(project)) if project else None
        self._send_attachment(buf.getvalue(), f"{label or 'Manager'} notes.zip", "application/zip")

    def _g_org_note_export(self, req):
        """GET /api/org/note/export?id=&format=md|docx|pdf — one note as a file
        to send someone (viewer/noteexport.py). 503 when this box cannot make
        the format (PDF without Chrome), so the client can say so plainly."""
        q = lambda k, d="": (req.query.get(k) or [d])[0]
        nid, fmt = q("id"), q("format", "md")
        if not nid.isdigit():
            self.send_json({"error": "id required"}, status=400); return
        note = db.note_get(int(nid))
        if not note:
            self.send_json({"error": "not found"}, status=404); return
        proj = db.project_get(note["project_id"]) if note.get("project_id") else None
        when = time.strftime("%-d %b %Y", time.localtime(note.get("updated_at") or time.time()))
        meta = " · ".join(x for x in ((note.get("kind") or "note").capitalize(), (proj or {}).get("name"),
                                      f"updated {when}") if x)
        try:
            data, ctype, name = noteexport.export(note, fmt, meta)
        except ValueError as e:
            self.send_json({"error": str(e)}, status=400); return
        except noteexport.ExportUnavailable as e:
            self.send_json({"error": str(e)}, status=503); return
        self._send_attachment(data, name, ctype)

    # ── the Map lens (a project's code as a drill-down graph) ─────────────────
    def _g_org_map(self, req):
        """GET /api/org/map?project=&level=project|folder|file&path=

        Re-parses only files whose mtime:size stamp changed (code_index is the
        cache), then folds them into the requested level. Opening the map turns
        the lens on, which is what makes agents' edits light up live (engine
        marks touched files only for projects with the lens). Local projects
        only — the parse reads files on this machine."""
        q = lambda k, d="": (req.query.get(k) or [d])[0]
        project = self._board_project(q("project") or None, q("session") or None)
        proj = db.project_get(int(project)) if project else None
        if not proj:
            self.send_json({"error": "a map is per project — open it from a project"}, status=400); return
        level, path = q("level", "project"), q("path").strip("/")
        if level not in ("project", "folder", "file"):
            self.send_json({"error": "level is project, folder or file"}, status=400); return
        if proj.get("host") not in (None, "", "local"):
            self.send_json({"error": f"the map reads code on this machine; {proj['name']} lives on {proj['host']}"},
                           status=400); return
        root = proj.get("cwd") or ""
        if not os.path.isdir(root) or root in ("/", os.path.expanduser("~")):
            self.send_json({"error": f"{root or 'this project'} is not a code folder this machine can map"},
                           status=400); return
        if not codemap.available():
            self.send_json({"available": False, "level": level, "path": path,
                            "install": "python3 -m pip install -r deploy/codemap-requirements.txt (into the Python that runs Manager)"})
            return
        if "map" not in (proj.get("lenses") or []):
            db.project_lens_set(proj["id"], "map", True)
        index, touched = self._map_index(proj["id"], root)
        if level == "file" and path not in index:
            self.send_json({"error": f"{path} is not a mapped source file"}, status=404); return
        g = codemap.graph(index, level, path, touched)
        self.send_json({"available": True, "project": proj["id"], "level": level, "path": path,
                        "files": len(index), "mermaid": codemap.to_mermaid(g),
                        "touched": touched, **g})

    @staticmethod
    def _map_index(project_id, root):
        """{rel: {symbols, deps}} with stale files re-parsed, plus
        {rel: session} for files an agent wrote within TOUCH_WINDOW."""
        with _map_locks_guard:
            lock = _map_locks.setdefault(project_id, threading.Lock())
        with lock:
            live = codemap.source_files(root)
            cached = db.code_index_load(project_id)
            resolver = codemap.Resolver(live)
            upserts = []
            for rel, stamp in live.items():
                row = cached.get(rel)
                if row and row["stamp"] == stamp:
                    continue
                try:
                    with open(os.path.join(root, rel), "rb") as f:
                        parsed = codemap.parse_file(rel, f.read())
                except OSError:
                    continue
                deps = sorted({d for d in (resolver.resolve(i, rel) for i in parsed["imports"]) if d})
                upserts.append((rel, stamp, parsed["symbols"], deps))
                cached[rel] = {**(row or {}), "symbols": parsed["symbols"], "imports": deps}
            if upserts or set(cached) - set(live):
                db.code_index_sync(project_id, upserts, live)
        horizon = time.time() - codemap.TOUCH_WINDOW
        index = {rel: {"symbols": cached[rel]["symbols"], "deps": cached[rel]["imports"]}
                 for rel in live if rel in cached}
        touched = {rel: r.get("touched_by", "") for rel, r in cached.items()
                   if rel in live and (r.get("touched_at") or 0) > horizon}
        return index, touched

    def _p_org_notes(self, req):
        body = self.read_body() or {}
        # A note written inside a chat belongs to that chat's project too, so the
        # project-wide notes view sees it — same birth rule as a card.
        if not body.get("project_id") and body.get("session"):
            body["project_id"] = self._board_project(None, body.get("session"))
        self._org_send(req, "note_create",
                       {**body, "created_by": req.principal["actor"]})

    def _p_org_notes_update(self, req):
        body = self.read_body() or {}
        if not body.get("note_id"):
            self.send_json({"error": "note_id required"}, status=400); return
        self._org_send(req, "note_update", body)

    def _p_org_notes_delete(self, req):
        body = self.read_body() or {}
        if not body.get("note_id"):
            self.send_json({"error": "note_id required"}, status=400); return
        self._org_send(req, "note_delete", body)

    # ── note discussions (the message board under every note) ───────────────
    @staticmethod
    def _voter(req):
        """Who a vote belongs to: an agent votes as its SESSION (two sessions
        sharing a role are two voices), a human as their user."""
        return req.principal.get("session") or req.principal["actor"]

    def _g_org_note_comments(self, req):
        """A note's discussion as a nested thread (discussion.thread), sorted
        best (votes) | new | old, with the caller's own vote on each comment."""
        nid = (req.query.get("note_id") or [None])[0]
        if not nid:
            self.send_json({"error": "note_id required"}, status=400); return
        flat = db.note_comment_list(int(nid), voter=self._voter(req))
        sort = (req.query.get("sort") or ["best"])[0]
        self.send_json({"comments": discussion.thread(flat, sort), "count": len(flat)})

    def _p_org_note_comment(self, req):
        """Comment on a note (or reply to a comment: parent_id). Author and
        session are stamped from the principal, never from the body."""
        body = self.read_body() or {}
        self._org_send(req, "note_comment",
                       {"note_id": body.get("note_id"), "parent_id": body.get("parent_id"),
                        "body": body.get("body", ""), "author": req.principal["actor"],
                        "session_id": req.principal.get("session") or ""})

    def _p_org_note_vote(self, req):
        body = self.read_body() or {}
        self._org_send(req, "note_vote",
                       {"comment_id": body.get("comment_id"), "value": body.get("value"),
                        "voter": self._voter(req)})

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
        resolution = body.get("resolution", "approved")
        if resolution == "approved" and (row.get("detail") or {}).get("action"):
            result, _ = actions.execute(row["detail"], p["human_role"], "")
        inbox.tell_requester(row, resolution, result)
        self.send_json({**row, **({"result": result} if result is not None else {})})

    def _g_org_audit(self, req):
        from urllib.parse import parse_qs
        from viewer import audit

        # _Req.query drops blank values. Preserve them here so an invalid view
        # cannot silently fall back to the legacy raw response.
        query = parse_qs(req.raw_query, keep_blank_values=True)
        if "view" not in query:
            limit = (req.query.get("limit") or ["100"])[0]
            self.send_json({"audit": db.audit_list(limit=int(limit))})
            return
        try:
            limit, before_id, result = audit.display_options(query)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, status=400)
            return
        rows = db.audit_list(limit=limit + 1, before_id=before_id, result=result)
        page = rows[:limit]
        entries = audit.name_references([audit.project_entry(row) for row in page],
                                        db.card_titles, db.board_column_names)
        self.send_json({"view": "display-v1", "audit": entries,
                        "next_before": page[-1]["id"] if len(rows) > limit else None})

    # ── maintenance window (viewer.maintenance) ──────────────────────────────
    def _g_org_maintenance(self, req):
        from viewer import maintenance
        self.send_json({"window_minute": maintenance.WINDOW_MINUTE,
                        "next_window": maintenance.next_window(time.time()),
                        "queued": db.restart_requests_by_status("queued")})

    def _p_org_maintenance_request(self, req):
        """Queue a restart for the next window. Requester stamped from the principal."""
        body, p = self.read_body() or {}, req.principal
        self._org_send(req, "restart_request",
                       {"reason": body.get("reason") or "", "commit": body.get("commit") or "",
                        "requested_by": p["actor"], "session_id": p["session"] or ""})

    def _p_org_maintenance_now(self, req):
        body = self.read_body() or {}
        self._org_send(req, "restart_now", {"requested_by": req.principal["actor"],
                                            "reason": body.get("reason") or ""})

    # ── Manager autonomous-manager config (owner surface) ─────────────────────
    def _g_org_orchestrator(self, req):
        from viewer.orchestrator import get_config
        self.send_json(get_config())

    def _p_org_orchestrator(self, req):
        """Write Manager config: the automation master switch, its only setting.

        It is a pair of actions so that resuming can be Red while pausing stays
        cheap — a session at manager level can stop the machine but can never
        restore its own supervision.
        """
        body = self.read_body() or {}
        if "automation_enabled" not in body:
            self.send_json({"error": "only automation_enabled is configurable"}, status=400)
            return
        self._org_send(req, "automation_resume" if body["automation_enabled"]
                       else "automation_pause", {"reason": body.get("reason") or ""})

    # ── Organizational learning: an agent or the owner proposes a skill ─────────────
    def _g_org_skills(self, req):
        """The team's skill library: every SKILL.md the CLI will load as /<name>
        (disk is the truth for what exists), joined with the learned-skill ledger
        for provenance. A ledger row whose file is gone shows as 'missing'."""
        from viewer import skills
        self.send_json({"skills": skills.library(db.skill_learned_list())})

    def _g_org_skill_read(self, req):
        """One skill's full SKILL.md by NAME (from skill_list). Name-resolved
        through skills.skills_base, never a caller path, so there is no
        traversal surface; an unknown name is simply not found."""
        from viewer import skills
        name = (req.query.get("name") or [""])[0].strip()
        if not skills.valid_name(name):
            self.send_json({"error": "Bad skill name"}, status=400); return
        p = skills.skills_base() / name / "SKILL.md"
        if not p.is_file():
            self.send_json({"error": "Skill not found"}, status=404); return
        self.send_json({"name": name, "path": str(p),
                        "content": p.read_text(errors="replace")})

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
                                          learned_by=req.principal["actor"])
        overlaps = orglogic.dedupe_skill(name, skills.list_skill_names())
        resp, status = self._org_run(
            req, "skill_promote" if overlaps else "skill_propose",
            {"name": name, "content": content, "card": body.get("from_card"),
             "session": body.get("session"), "reason": body.get("reason") or ""})
        if resp.get("queued"):
            # Queued for review: record the intent in the skill ledger too, so the
            # library shows a pending entry instead of the proposal vanishing until
            # someone opens the approvals list.
            rec = db.skill_learned_record(name, path="", origin_card=body.get("from_card"),
                                          origin_session=body.get("session"),
                                          status="proposed")
            resp = {**resp, "skill": rec["id"]}
        self.send_json(resp, status=status)

    # ── Loop control: WHICH origins may fire (owner control panel) ────────────
    def _g_org_loop_control(self, req):
        from viewer.orchestrator import get_loop_control
        self.send_json(get_loop_control())

    def _p_org_loop_control(self, req):
        """Set the loop-firing mode (user/agent/both/none). Manager-scoped,
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
                       {"preamble": body.get("preamble", ""),
                        "reason": body.get("reason") or ""})

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

    # ── Agent-scheduled loops (origin='agent', gated) ────────────────────────
    # The AGENT path to scheduling recurring work. The human UI keeps its own
    # ungated loop routes (routes.sessions): a person editing their own schedules
    # is not an org action. These run through the org gate and stamp origin='agent'
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

    def _own_loop_change(self, req, target_session, op, body):
        """For a change aimed at the caller's OWN session: True if it is one of the
        narrowing changes orglogic.self_loop_change_allowed grants (a one-shot wake,
        a pause), else refuse it through the self-mutation rail (403). False, with
        nothing sent, when the target is another session — the normal path."""
        acting = req.principal.get("session") or ""
        if not orglogic.mutates_own_session(acting, target_session or ""):
            return False
        if orglogic.self_loop_change_allowed(op, body):
            return True
        self._self_mutation_denied(
            req, target_session,
            reason="a session may set itself a one-time wake (`at`) or pause its "
                   "own loop (enabled=false alone), never schedule, resume, edit "
                   "or delete it")
        return None

    def _p_org_loops(self, req):
        """Create an agent-origin loop. For the caller's own session only a one-shot
        wake is allowed (see _own_loop_change); any schedule for another session.

        The target session travels as `for_session`, NOT `session`: the MCP transport
        mirrors the CALLER's own session id into the body's `session` field as a
        credential, so a target named `session` would always equal the acting session
        and the self-mutation rail would refuse every create. `for_session` is
        untouched by that transport, so the rail compares real values.
        """
        body = self.read_body() or {}
        target = (body.get("for_session") or "").strip()
        if self._own_loop_change(req, target, "create", body) is None:
            return
        self._org_send(req, "loop_create", {
            "session": target, "path": body.get("path", ""),
            "prompt": body.get("prompt", ""), "cron": body.get("cron"),
            "interval": body.get("interval"), "at": body.get("at"),
            "model": body.get("model", ""),
            "provider": body.get("provider", "")})

    def _p_org_loops_update(self, req):
        """Edit an agent-origin loop. The rail resolves the loop's OWN session (not a
        body field) so a caller cannot dodge it by omitting/spoofing the session.
        On its own session a caller may only pause — and that pause may reach a loop
        the owner authored, so the route (never the body) stamps `own_pause` for
        _loop_update's origin guard."""
        body = self.read_body() or {}
        body.pop("own_pause", None)
        loop = db.loop_get(body.get("id", ""))
        if not loop:
            self.send_json({"error": "not found"}, status=404); return
        own = self._own_loop_change(req, loop.get("session"), "update", body)
        if own is None:
            return
        if own:
            body = {"id": body["id"], "enabled": False, "own_pause": True}
        self._org_send(req, "loop_update", body)

    def _p_org_loops_delete(self, req):
        body = self.read_body() or {}
        loop = db.loop_get(body.get("id", ""))
        if not loop:
            self.send_json({"error": "not found"}, status=404); return
        if self._self_mutation_denied(req, loop.get("session")):
            return
        self._org_send(req, "loop_delete", {"id": body.get("id", ""),
                                            "reason": body.get("reason") or ""})
