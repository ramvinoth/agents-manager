"""viewer.actions — the ONE definition of every mutating org action, and the ONE
gate that runs them.

An intent is plain JSON: {"action", "args", "actor"}. That is the whole point.
The previous design passed a closure (`_org_do(..., mutate)`), so an action that
could not run *right now* could not run at all: the closure died with the request
and approving a queued action did nothing. Storing an intent in `approvals.detail`
(already JSONB) and re-dispatching it through the same `execute()` makes deferred
execution work, gives `audit_log.target` a replayable record, and means HTTP, the
MCP proxy and the approval path cannot drift — there is one code path.

Handlers take a single dict and return the response body. They must resolve
derived facts (e.g. WHICH column is "Done") at execution time, not at queue time:
a stored intent may be approved much later, and a column id frozen at queue time
can be stale or deleted by then. Late binding is why intents beat closures.

Policy lives in orglogic (pure, no db). This module composes policy with the db
and writes the audit trail; it is the only place that does.
"""
import sys
import time

from viewer import db, orglogic


def _card_create(a):
    return db.card_create(a.get("title", ""), a.get("body", ""), a.get("column_id"),
                          a.get("assignee"), a.get("project_id"), a.get("session"),
                          a.get("position", 1.0), a.get("created_by", ""))


def _card_update(a):
    fields = {k: v for k, v in a.items()
              if k in ("title", "body", "column_id", "assignee", "project_id", "position")}
    return db.card_update(a.get("card_id"), **fields) or {"error": "not found"}


def _card_move(a):
    return db.card_move(a.get("card_id"), a.get("column_id"),
                        a.get("position", 1.0)) or {"error": "not found"}


def _card_assign(a):
    return db.card_assign(a.get("card_id"), a.get("assignee")) or {"error": "not found"}


def _card_delete(a):
    return {"deleted": bool(db.card_delete(a.get("card_id")))}


def _task_done(a):
    """Move a card to the Done column of its own project's board.

    WHICH column is Done is resolved HERE, not by the caller: this action can be
    queued as Red and approved later, by which time a column may have been added,
    reordered or removed. Storing a column id in the intent would freeze a fact
    that is only true at queue time. Name-first (orglogic.project_columns): the
    default pipeline puts decision columns (Review/Approved/…) BETWEEN Doing and
    Done, so "the last column" is no longer a safe rule on its own.
    """
    card = db.card_get(a.get("card_id"))
    cols = db.board_columns_list(card["project_id"]) if card and card.get("project_id") else []
    done_id = orglogic.project_columns(cols).get("done") or (cols[-1]["id"] if cols else None)
    return db.card_move(a.get("card_id"), done_id,
                        a.get("position", 1.0)) or {"error": "not found"}


def _card_comment(a):
    """Post a comment on a card's discussion thread (db.card_comments).
    The author is stamped by the route from the resolved principal — never
    trusted from the body — so a forged author cannot talk in someone else's
    voice on the board."""
    card = db.card_get(a.get("card_id"))
    if not card:
        return {"error": "not found"}
    body = (a.get("body") or "").strip()
    if not body:
        return {"error": "empty comment"}
    return db.card_comment_add(card["id"], a.get("author", ""), body)


def _card_dep_add(a):
    """Add a card→card dependency edge: `card_id` cannot move forward until
    `depends_on` reaches a Done column. Both endpoints must exist; a self-edge
    is rejected by db.card_dep_add. Adding a blocker is work-shaping, so the
    follow-up wakes the card's session with the blocking state."""
    card = db.card_get(a.get("card_id"))
    if not card:
        return {"error": "not found"}
    dep = db.card_get(a.get("depends_on"))
    if not dep:
        return {"error": "dependency not found"}
    return db.card_dep_add(card["id"], dep["id"], a.get("created_by", ""))


def _card_dep_remove(a):
    """Remove a dependency edge. The removal can unblock a card, so the
    follow-up wakes the card's session."""
    return {"removed": db.card_dep_remove(a.get("card_id"), a.get("depends_on"))}


def _column_create(a):
    return db.board_column_create(a.get("project_id"), a.get("name", ""), a.get("position", 0))


def _column_update(a):
    return db.board_column_update(a.get("id"), name=a.get("name"),
                                  position=a.get("position")) or {"error": "not found"}


def _column_delete(a):
    return {"deleted": db.board_column_delete(a.get("id"))}


def _project_create(a):
    return db.project_create(a.get("name", ""), a.get("description", ""),
                             a.get("host", "local"), a.get("cwd", ""), a.get("created_by", ""))


def _project_ensure(a):
    """Find-or-create the project for a directory. Distinct from project_create:
    it is idempotent and keys on a NORMALIZED cwd, so the web entry point and a
    spawned agent session naming the same dir differently land on one project."""
    return db.project_ensure(a.get("host", "local"), a.get("cwd", ""),
                             a.get("name", ""), a.get("created_by", ""))


def _employee_create(a):
    return db.employee_create(a.get("name", ""), a.get("role", ""), a.get("provider", ""),
                              a.get("model", ""), a.get("conv_mode", "chat"), a.get("avatar", ""))


def _employee_update(a):
    fields = {k: v for k, v in a.items()
              if k in ("name", "role", "provider", "model", "conv_mode", "avatar", "status")}
    updated = db.employee_update(a.get("id"), **fields)
    if not updated:
        return {"error": "not found"}
    # Deactivating an employee (status → anything but active, e.g. archived) stops
    # its scheduled work: disable every loop whose session runs AS this employee,
    # linked by the employee's provider preset id. Reversible — restoring the
    # employee leaves the (disabled) loops in place to be re-enabled.
    if "status" in fields and (fields["status"] or "active") != "active":
        db.loops_disable_for_employee(updated.get("provider") or "")
    return updated


def _harman_config(a):
    from viewer.orchestrator import set_config
    return set_config(a.get("patch") or {})


def _automation_set(on):
    from viewer.orchestrator import set_automation
    return set_automation(on)


# The master switch is two actions over one body, so the two DIRECTIONS can carry
# different risk: resuming is Red (orglogic._RED_ACTIONS), pausing is not. An agent
# can therefore always stop the machine, and can only ASK to restart it.
#
# The value comes from WHICH action ran, never from an argument. An intent is
# persisted and replayed later, so an args-driven flag would let a caller name the
# safe action while carrying the dangerous payload — and would let an approval for
# "pause" execute as "resume".
def _automation_pause(a):
    return _automation_set(False)


def _automation_resume(a):
    return _automation_set(True)


def _approval_resolve(a):
    return db.approval_resolve(a.get("id"), a.get("resolution", "approved")) \
        or {"error": "not found"}


# ── Agent-scheduled loops (origin='harman') ──────────────────────────────────
# The human UI writes loops through routes.sessions (origin='user', ungated — a
# person editing their own schedules). These three are the AGENT path: an employee
# session asks Harman's org gate to schedule recurring work, so they run through
# execute() like every other org action and carry origin='harman'.
#
# Origin is stamped HERE, server-side, never taken from args: an intent is
# persisted and replayed, so a caller-supplied origin could forge a 'user' loop to
# dodge the loop_control dropdown. WHICH path built the loop is the fact that
# decides its origin, exactly like the automation pause/resume direction.
#
# The session a loop drives must exist (its transcript is what --resume replays);
# validation of the session + the self-mutation rail live at the route, which has
# the acting principal. Here we assume a resolved, non-self session.
def _loop_create(a):
    from viewer.loops import build_schedule
    import uuid as _uuid
    prompt = (a.get("prompt") or "").strip()
    session = (a.get("session") or "").strip()
    if not prompt:
        return {"error": "Empty prompt"}
    if not session:
        return {"error": "session required"}
    # `at` makes this a one-shot (kind='once'): fires once at that time, then
    # the scheduler deletes the row. A run can schedule its own next wake by
    # calling this again at the end of itself.
    sched, err = build_schedule(a.get("cron"), a.get("interval"), a.get("at"))
    if err:
        return {"error": err}
    lid = _uuid.uuid4().hex[:12]
    entry = {"session": session, "path": a.get("path", ""), "prompt": prompt,
             "runs": 0, "created": time.time(), "enabled": True,
             "model": (a.get("model") or "").strip(),
             "provider": (a.get("provider") or "").strip(),
             "origin": "harman", **sched}
    db.loop_upsert(lid, entry)
    return {"created": lid, "origin": "harman",
            "kind": sched.get("kind", "recurring"),
            "interval": sched.get("interval") or 0, "cron": sched.get("cron"),
            "nextRun": sched.get("nextRun")}


def _loop_update(a):
    """Patch a harman-origin loop's prompt/schedule/model/enabled. Refuses to touch
    a user-origin loop: the two paths own disjoint sets, so an agent can never edit
    a schedule a human authored (and vice-versa the human route ignores origin
    because a person may edit anything they can see)."""
    from viewer.loops import build_schedule
    lid = a.get("id", "")
    loop = db.loop_get(lid)
    if not loop:
        return {"error": "not found"}
    if (loop.get("origin") or "user") != "harman":
        return {"error": "not an agent loop"}
    fields = {}
    if "prompt" in a:
        prompt = (a.get("prompt") or "").strip()
        if not prompt:
            return {"error": "Empty prompt"}
        fields["prompt"] = prompt
    if "model" in a:
        fields["model"] = (a.get("model") or "").strip()
    if "provider" in a:
        fields["provider"] = (a.get("provider") or "").strip()
    if "enabled" in a:
        fields["enabled"] = bool(a.get("enabled"))
    if "at" in a:
        # An explicit `at` REPLACES the schedule with a one-shot — the loop's
        # existing cron/interval must not shadow it (build_schedule's cron-wins
        # precedence would otherwise swallow the `at` silently).
        sched, err = build_schedule(None, None, a.get("at"))
    elif "cron" in a or "interval" in a:
        # A cron or interval converts the loop back to recurring (kind comes
        # from build_schedule).
        sched, err = build_schedule(a.get("cron", loop.get("cron")),
                                    a.get("interval", loop.get("interval")))
    else:
        sched = None
    if sched is not None:
        if err:
            return {"error": err}
        fields.update(sched)
    updated = db.loop_update(lid, fields)
    return {"updated": lid, "kind": updated.get("kind", "recurring"),
            "interval": updated.get("interval"), "cron": updated.get("cron")} \
        if updated else {"error": "not found"}


def _loop_delete(a):
    """Delete a harman-origin loop (Red → queued for the owner). Same origin guard
    as _loop_update: the agent path cannot remove a human's schedule."""
    lid = a.get("id", "")
    loop = db.loop_get(lid)
    if not loop:
        return {"error": "not found"}
    if (loop.get("origin") or "user") != "harman":
        return {"error": "not an agent loop"}
    return {"deleted": bool(db.loop_delete(lid))}


def _loop_mode_set(a):
    from viewer.orchestrator import set_loop_mode
    return set_loop_mode((a.get("mode") or "").strip())


def _session_mode_set(a):
    """Set the permission mode a session's runs start in.

    Stored in the session's meta; engine.effective_permission_mode applies it at
    run start (loops AND chat runs), overriding whatever the caller requested.
    The value is validated against orglogic.PERMISSION_MODES — the CLI's own
    vocabulary ('bypass' is what the run becomes --dangerously-skip-permissions
    for).

    Red (orglogic): a model may REQUEST a session's trust level change, never
    grant it — the request queues for the owner, who approves in the UI. The
    owner at the UI self-approves (he is the one delegating)."""
    session = (a.get("session") or "").strip()
    mode = (a.get("mode") or "").strip()
    if not session:
        return {"error": "session required"}
    if mode not in orglogic.PERMISSION_MODES:
        return {"error": f"mode must be one of {', '.join(orglogic.PERMISSION_MODES)}"}
    db.session_meta_patch(session, {"permission_mode": mode})
    return {"session": session, "permission_mode": mode}


def _system_preamble_set(a):
    """Set the global system-awareness preamble prepended to EVERY session's
    system prompt (engine.append_system_prompt). Empty string disables it.

    Red + manager (orglogic): rewriting this injects instructions fleet-wide into
    every future session, so an agent's attempt queues for the owner — the same
    rail as skill_promote overwriting shared knowledge. The owner editing at the
    UI self-approves and it applies now. Stored as a plain JSON string."""
    text = a.get("preamble", "")
    text = text if isinstance(text, str) else str(text or "")
    db.setting_set("system_preamble", text)
    return {"preamble": text}


def _skill_write(a):
    """Write a skill into the shared library and mark it active in the ledger.

    Shared by `skill_propose` (novel → green, runs immediately) and
    `skill_promote` (overwrites a teammate's skill → red, runs on approval). The
    two actions differ ONLY in risk class, so they share this one body — which is
    what lets the approval path re-dispatch instead of re-implementing the write.
    """
    from viewer import skills
    name = (a.get("name") or "").strip()
    if not skills.valid_name(name):
        return {"error": "Bad skill name"}
    path = skills.write_skill(name, a.get("content", ""))
    existing = [s for s in db.skill_learned_list(status="proposed") if s.get("name") == name]
    if existing:
        for s in existing:
            db.skill_learned_set_status(s["id"], "active")
        rec = existing[0]
    else:
        rec = db.skill_learned_record(name, path=str(path), origin_employee=None,
                                      origin_card=a.get("card"),
                                      origin_session=a.get("session"), status="active")
    return {"promoted": True, "path": str(path), "skill": rec["id"]}


# action name -> handler. An action missing here cannot be executed at all, which
# keeps the registry and orglogic._MIN_LEVEL honest (see the invariant test).
ACTIONS = {
    "card_create": _card_create,
    "card_update": _card_update,
    "card_move": _card_move,
    "card_assign": _card_assign,
    "card_delete": _card_delete,
    "card_comment": _card_comment,
    "card_dep_add": _card_dep_add,
    "card_dep_remove": _card_dep_remove,
    "task_done": _task_done,
    "column_create": _column_create,
    "column_update": _column_update,
    "column_delete": _column_delete,
    "project_create": _project_create,
    "project_ensure": _project_ensure,
    "employee_create": _employee_create,
    "employee_update": _employee_update,
    "harman_config": _harman_config,
    "automation_pause": _automation_pause,
    "automation_resume": _automation_resume,
    "approval_resolve": _approval_resolve,
    "loop_create": _loop_create,
    "loop_update": _loop_update,
    "loop_delete": _loop_delete,
    "loop_mode_set": _loop_mode_set,
    "session_mode_set": _session_mode_set,
    "system_preamble_set": _system_preamble_set,
    "skill_propose": _skill_write,
    "skill_promote": _skill_write,
}


# Request fields that are CREDENTIALS, never action arguments. An MCP subprocess
# posts its per-run session+token in the body (viewer_mcp.py), and an intent is
# persisted to approvals.detail and audit_log.target — so without this strip, every
# queued Red action would park a live token in the database, readable by anyone who
# can list approvals. The principal is already resolved from headers at the gate
# before any body is read; by the time an intent is built these are dead weight.
#
# Stripped in intent() rather than at each call site so a new route cannot forget.
_CREDENTIAL_FIELDS = ("token", "password", "secret", "api_key")


def intent(action, args, actor):
    """Build the JSON record of "someone wants to do X". Storable verbatim in
    approvals.detail and replayable from audit_log.target — which is exactly why
    credential fields are dropped here (see _CREDENTIAL_FIELDS)."""
    return {"action": action, "actor": actor,
            "args": {k: v for k, v in (args or {}).items()
                     if k not in _CREDENTIAL_FIELDS}}


# Board actions whose success means the card's OWN session (or the owner) must
# find out — the board is the conversation between them (see boardwatch).
_BOARD_ACTIONS = ("card_move", "card_update", "card_comment",
                  "card_dep_add", "card_dep_remove", "task_done")


def _board_followup(action, args, actor, session_level, acting_session):
    """After a successful board event, wake the card's own session (boardwatch)
    and — when an AGENT comments — push the owner. Never fails the action: the
    mutation has already committed, so a wake failure is logged, not raised.

    The two follow-ups have different audiences, and that decides when each
    fires:

    - the WAKE goes to the card's session, so it fires only when the event
      came from OUTSIDE that session (a human, or another session). The
      card's own session acting on its own card already knows; a self-wake
      would be a loop. Origin mirrors the cause (boardwatch's contract):
      a human made it → 'user', a foreign agent made it → 'harman'.
    - the PUSH goes to the owner (a person), so it fires even when the
      card's own session comments — that is exactly how a worker reports
      status ("stuck on X") without a self-wake.
    """
    if action not in _BOARD_ACTIONS:
        return
    try:
        from viewer import boardwatch
        from viewer.loops import AGENT_ORIGIN, USER_ORIGIN

        card = db.card_get(args.get("card_id"))
        if not card or not card.get("session_id"):
            return
        agent = bool(session_level)
        if action == "card_comment":
            body = (args.get("body") or "").strip()
            excerpt = body[:200] + ("…" if len(body) > 200 else "")
        else:
            excerpt = ""
        if agent and action == "card_comment":
            from viewer import push
            push.notify_all(f"Board · {card.get('title', '')}",
                            f"{actor}: {excerpt}"[:300])
        if agent and card.get("session_id") == (acting_session or ""):
            return
        if action == "card_move":
            cols = db.board_columns_list(card["project_id"]) \
                if card.get("project_id") else []
            col = next((c for c in cols if c["id"] == card.get("column_id")), None)
            event = f"moved to '{(col or {}).get('name') or card.get('column_id')}' by {actor}"
        elif action == "task_done":
            event = f"marked done by {actor}"
        elif action == "card_update":
            event = f"updated by {actor}"
        elif action == "card_comment":
            event = f"new comment by {actor}: \"{excerpt}\""
        elif action in ("card_dep_add", "card_dep_remove"):
            dep = db.card_get(args.get("depends_on"))
            title = f'card {dep["id"]} "{dep.get("title", "")}"' if dep else "the referenced card"
            if action == "card_dep_add":
                event = (f"new dependency: {title} is not done — you are blocked "
                         f"until it reaches Done (added by {actor}); comment why the "
                         f"card cannot advance")
            else:
                event = (f"dependency on {title} removed by {actor} — you may be "
                         f"able to proceed; comment your next step")
        boardwatch.schedule_wake(card, event,
                                 USER_ORIGIN if not agent else AGENT_ORIGIN)
    except Exception as e:
        print(f"[boardwatch] wake for card {args.get('card_id')} failed: {e}",
              file=sys.stderr)


def execute(it, human_role, session_level, acting_session=""):
    """Run an intent through both gates, then audit. Returns (payload, status).

    - scope: orglogic.allowed(action, level) — within this authority? → 403
    - risk:  orglogic.classify_action(action) — Green runs; Red opens an approval
      holding the INTENT, unless orglogic.self_approves says this principal's own
      action is the approval (the owner clicking in the UI; never an agent).

    Approving that stored intent calls execute() again with the approver's role
    and no session level, so it takes the same path — one policy, not two.

    `acting_session` is the session whose request built this intent (an agent's
    own id, or '' for a human at the UI / an approval re-dispatch). Only the
    board follow-up needs it: to know the event came from OUTSIDE the card's
    session (a foreign agent) rather than the card's own session.
    """
    action = it.get("action", "")
    args, actor = it.get("args") or {}, it.get("actor", "")
    level = orglogic.effective_level(human_role, session_level)
    if not orglogic.allowed(action, level):
        db.audit_append(actor, action, it, "denied:scope")
        return {"denied": True, "reason": f"{level} not authorized for {action}"}, 403
    handler = ACTIONS.get(action)
    if handler is None:
        # Scope-allowed but not runnable: a table/registry mismatch, not a caller
        # error. Fail loudly rather than reporting a success that never happened.
        db.audit_append(actor, action, it, "error:unknown_action")
        return {"error": f"unknown action {action}"}, 500
    if (orglogic.is_red(action)
            and not orglogic.self_approves(human_role, session_level)):
        ap = db.approval_open(kind="infra", summary=f"{actor}: {action}",
                              detail=it, created_by=actor)
        db.audit_append(actor, action, it, "queued:red")
        return {"queued": True, "approval": ap["id"]}, 200
    payload = handler(args)
    db.audit_append(actor, action, it, "done")
    if not (payload or {}).get("error"):
        _board_followup(action, args, actor, session_level, acting_session)
    return payload, 200
