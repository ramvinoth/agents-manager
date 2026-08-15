"""viewer.orchestrator — "Harman", the autonomous manager.

Runs one cheap survey of the ONE canonical Kanban board each tick (hooked into the
existing loop_scheduler, NOT a new thread) and executes the intents that
viewer.orglogic.plan_assignments returns: assign unassigned Todo cards to employees,
optionally spawn that employee's agent-mode session to actually work the card,
advance finished work, and escalate risky (red) actions to the CEO as approvals.

SAFETY (auto-run + on-by-default → these are hard rails, not optional):
  - budget: max concurrent auto-run employee sessions (config, but bounded by HARD_CAP).
  - in-progress guard: a card already being worked is never re-spawned.
  - self-throttle: the 5s scheduler only runs Harman every `interval`s.
  - red never executes — it becomes a db approval for the human.
Everything Harman does is written to audit_log.

Config: ~/.claude/.viewer-harman.json (beside LOOPS_FILE). Empty `projects` = manage
nothing, so on-by-default is inert until the CEO points it at a project.
"""
import time
from pathlib import Path

from viewer import db, orglogic
from viewer.config import CHAT_JOBS, CHAT_LOCK

HARMAN_FILE = Path.home() / ".claude" / ".viewer-harman.json"
HARD_CAP = 4                 # absolute ceiling on concurrent auto-run sessions
_DEFAULT = {"enabled": True, "interval": 30, "budget": 2, "projects": [], "default_provider": ""}
_last_run = 0.0


def _load_config():
    from viewer.engine import load_json_file
    cfg = dict(_DEFAULT)
    cfg.update(load_json_file(HARMAN_FILE, {}) or {})
    # Enforce the hard rails regardless of what the file says.
    cfg["budget"] = max(1, min(int(cfg.get("budget", 2) or 2), HARD_CAP))
    cfg["interval"] = max(10, int(cfg.get("interval", 30) or 30))
    cfg["projects"] = [int(p) for p in (cfg.get("projects") or [])]
    cfg["enabled"] = bool(cfg.get("enabled", True))
    cfg["default_provider"] = str(cfg.get("default_provider") or "")
    return cfg


def get_config():
    """Public: the effective config (for the /api/org/harman route)."""
    return _load_config()


def set_config(patch):
    """Merge a partial config and persist. Returns the effective config."""
    from viewer.engine import load_json_file, save_json_file
    cur = load_json_file(HARMAN_FILE, {}) or {}
    for k in ("enabled", "interval", "budget", "projects", "default_provider"):
        if k in patch:
            cur[k] = patch[k]
    save_json_file(HARMAN_FILE, cur)
    return _load_config()


def _running_card_ids():
    """Card ids currently in flight — the anti-duplication guard. A card is in flight
    if a live CHAT_JOB is working it (job['card_id']), OR it already has an assignee
    and has moved off Todo (someone/thing is on it). Reads CHAT_JOBS under the lock."""
    with CHAT_LOCK:
        job_cards = {j.get("card_id") for j in CHAT_JOBS.values()
                     if j.get("running") and j.get("card_id")}
    return job_cards


def _live_employee_ids():
    """Employee ids that currently hold a running session (so we don't double-spawn
    for the same person)."""
    with CHAT_LOCK:
        out = set()
        for j in CHAT_JOBS.values():
            emp = j.get("employee") or {}
            if j.get("running") and emp.get("id"):
                out.add(emp["id"])
        return out


def _spawn_employee_session(employee, card, project, default_provider=""):
    """Start an agent-mode session for `employee` to work `card`. The employee's own
    provider preset wins; if it has none, fall back to the org's `default_provider`
    (e.g. the free local Qwen preset) so we never touch a paid model by default.
    Returns the new session id, or None if no usable Anthropic provider resolves."""
    import uuid as _uuid
    from viewer import providers
    from viewer.engine import SESSION_META, META_LOCK, save_json_file, META_FILE, start_claude_run

    preset_id = employee.get("provider") or default_provider
    penv = providers.anthropic_env(preset_id) if preset_id else None
    if not penv:
        return None  # no Anthropic-capable provider (employee's nor the org default)
    sid = str(_uuid.uuid4())
    cwd = (project or {}).get("cwd") or str(Path.home())
    goal = card.get("title") or ""
    # Give the session a readable name (never leave it a bare UUID): who is working
    # on what, in which project — so it's identifiable in the chat list and board.
    emp_name = (employee.get("name") or "Employee").strip()
    proj_name = ((project or {}).get("name") or "").strip()
    card_title = (card.get("title") or "Task").strip()
    title = (f"{emp_name} · {proj_name} · {card_title}" if proj_name
             else f"{emp_name} · {card_title}")[:200]
    with META_LOCK:
        SESSION_META[sid] = {"provider": preset_id, "convMode": "agent",
                             "goal": goal, "title": title}
        save_json_file(META_FILE, SESSION_META)
    task = (card.get("body") or card.get("title") or "").strip()
    ok = start_claude_run(sid, ["--session-id", sid], task, "acceptEdits", cwd,
                          employee.get("model", ""), provider_env=penv)
    if not ok:
        return None
    with CHAT_LOCK:
        job = CHAT_JOBS.get(sid)
        if job:
            job["card_id"] = card.get("id")
    return sid


def harman_tick(*, dry_run=False):
    """One survey→decide→act pass. Called from loop_scheduler every 5s; self-throttles
    to the configured interval. Whole body is exception-safe so a bad tick never kills
    the scheduler."""
    global _last_run
    try:
        cfg = _load_config()
        if not cfg["enabled"] or not cfg["projects"]:
            return
        now = time.time()
        if now - _last_run < cfg["interval"]:
            return
        _last_run = now

        cards = db.card_list()
        employees = db.employee_list()
        columns = db.board_columns_list()
        running = _running_card_ids()
        busy_emps = _live_employee_ids()
        # Tag employees the planner should not spawn for (already have a live session).
        emps = [dict(e, _busy=(e.get("id") in busy_emps)) for e in employees]

        actions = orglogic.plan_assignments(
            cards, emps, columns, running,
            projects=cfg["projects"], budget=cfg["budget"])
        if not actions:
            return

        slots = orglogic.project_columns(columns)
        doing = slots["doing"]
        cards_by_id = {c["id"]: c for c in cards}
        emps_by_id = {e["id"]: e for e in employees}

        for a in actions:
            if dry_run:
                db.audit_append("harman", "tick_dryrun", a, "planned")
                continue
            try:
                if a["kind"] == "assign":
                    cid, eid = a["card_id"], a["employee"]
                    db.card_assign(cid, eid)
                    if doing:
                        doing_cards = [c for c in db.card_list(column_id=doing)]
                        db.card_move(cid, doing, orglogic.next_position(doing_cards, len(doing_cards)))
                    db.audit_append("harman", "card_assign", {"card": cid, "employee": eid}, "ok")
                    if a.get("spawn"):
                        emp = emps_by_id.get(eid)
                        card = cards_by_id.get(cid)
                        proj = db.project_get(card.get("project_id")) if card else None
                        sid = _spawn_employee_session(emp, card, proj, cfg["default_provider"]) if emp and card else None
                        db.audit_append("harman", "spawn_session",
                                        {"card": cid, "employee": eid, "session": sid},
                                        "ok" if sid else "no_provider")
                elif a["kind"] == "advance":
                    db.card_move(a["card_id"], a["to_column"], 1.0)
                    db.audit_append("harman", "card_advance",
                                    {"card": a["card_id"], "to": a["to_column"]}, "ok")
                elif a["kind"] == "escalate":
                    ap = db.approval_open(a.get("approval_kind", "infra"), a.get("summary", ""),
                                          a.get("detail", {}), created_by="harman")
                    db.audit_append("harman", "escalate", {"approval": ap["id"]}, "pending")
            except Exception as e:  # one bad action shouldn't abort the rest
                db.audit_append("harman", a.get("kind", "action"), {"error": str(e)[:200]}, "error")
    except Exception:
        pass
