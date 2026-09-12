"""viewer.orchestrator — "Harman", the autonomous manager.

Runs one cheap survey of the ONE canonical Kanban board each tick (hooked into the
existing loop_scheduler, NOT a new thread) and executes the intents that
viewer.orglogic.plan_assignments returns: assign unassigned Todo cards to employees,
optionally spawn that employee's agent-mode session to actually work the card,
advance finished work, and escalate risky (red) actions to the CEO as approvals.

SAFETY (auto-run → these are hard rails, not optional):
  - `automation_enabled`: the master switch, default OFF. Nothing runs unattended
    until the owner turns it on, and turning it off pauses EVERY unattended path —
    see `automation_enabled()` below and its one enforcement point in
    engine.loop_scheduler.
  - budget: max concurrent auto-run employee sessions (config, but bounded by HARD_CAP).
  - in-progress guard: a card already being worked is never re-spawned.
  - self-throttle: the 5s scheduler only runs Harman every `interval`s.
  - red never executes — it becomes a db approval for the human.
Everything Harman does is written to audit_log.

Config: ~/.claude/.viewer-harman.json (beside LOOPS_FILE). Empty `projects` = manage
nothing, so an enabled Harman is still inert until the CEO points it at a project.
"""
import time
from pathlib import Path

from viewer import db, orglogic
from viewer.config import CHAT_JOBS, CHAT_LOCK

HARMAN_FILE = Path.home() / ".claude" / ".viewer-harman.json"
HARD_CAP = 4                 # absolute ceiling on concurrent auto-run sessions
_DEFAULT = {"automation_enabled": False, "enabled": True, "interval": 30, "budget": 2,
            "projects": [], "default_provider": ""}
_last_run = 0.0


def _load_config():
    from viewer.engine import load_json_file
    cfg = dict(_DEFAULT)
    cfg.update(load_json_file(HARMAN_FILE, {}) or {})
    # Enforce the hard rails regardless of what the file says.
    cfg["budget"] = max(1, min(int(cfg.get("budget", 2) or 2), HARD_CAP))
    cfg["interval"] = max(10, int(cfg.get("interval", 30) or 30))
    cfg["projects"] = [int(p) for p in (cfg.get("projects") or [])]
    cfg["automation_enabled"] = bool(cfg.get("automation_enabled", False))
    cfg["enabled"] = bool(cfg.get("enabled", True))
    cfg["default_provider"] = str(cfg.get("default_provider") or "")
    return cfg


def automation_enabled():
    """The master switch: may ANYTHING run unattended right now?

    Read fresh from disk on every call, deliberately — a pause has to take effect
    within one scheduler pass, and a cached value would keep work running after the
    owner flipped the switch. The file is small and the caller ticks every 5s.

    Defaults FALSE, including for a config file written before this key existed: the
    fail-safe direction for "is it safe to leave the machine alone" is off. An
    unreadable or corrupt file also yields False, because `load_json_file` falls back
    to `{}` and the default stands.

    Distinct from `enabled`, which scopes only Harman's own manager tick. This one
    covers every unattended path, so a path added later is paused by default too.
    """
    return _load_config()["automation_enabled"]


def get_config():
    """Public: the effective config (for the /api/org/harman route)."""
    return _load_config()


# Config keys `set_config` will merge. The master switch is NOT here — it has its
# own writer below, because the two directions carry different risk and a generic
# patch cannot express that. Keeping it out means no future caller can un-pause the
# machine by tacking a key onto an ordinary config write.
_PATCH_KEYS = ("enabled", "interval", "budget", "projects", "default_provider")


def _write(patch):
    from viewer.engine import load_json_file, save_json_file
    cur = load_json_file(HARMAN_FILE, {}) or {}
    cur.update(patch)
    save_json_file(HARMAN_FILE, cur)
    return _load_config()


def set_config(patch):
    """Merge a partial config and persist. Returns the effective config.

    Cannot touch `automation_enabled` — see `_PATCH_KEYS` and `set_automation`.
    """
    return _write({k: patch[k] for k in _PATCH_KEYS if k in patch})


def set_automation(on):
    """The ONLY writer of the master switch. Separate from `set_config` so that
    flipping it is always a distinct, individually-gated act (Red to resume, cheap
    to pause — see orglogic) rather than one key inside a bulk config patch."""
    return _write({"automation_enabled": bool(on)})


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

        employees = db.employee_list()
        running = _running_card_ids()
        busy_emps = _live_employee_ids()
        # Tag employees the planner should not spawn for (already have a live session).
        emps = [dict(e, _busy=(e.get("id") in busy_emps)) for e in employees]
        emps_by_id = {e["id"]: e for e in employees}

        # Columns are per-project now, so plan each managed project against its own
        # board and act on its actions before moving to the next.
        for pid in cfg["projects"]:
            cards = db.card_list(project_id=pid)
            columns = db.board_columns_list(pid)
            actions = orglogic.plan_assignments(
                cards, emps, columns, running,
                projects=[pid], budget=cfg["budget"],
                default_provider=cfg["default_provider"])
            if not actions:
                continue

            slots = orglogic.project_columns(columns)
            doing = slots["doing"]
            cards_by_id = {c["id"]: c for c in cards}

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
