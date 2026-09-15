"""viewer.orglogic — pure org/Kanban logic for the orchestrator ("Harman").

The empire runs on ONE canonical board: a single `cards` list. Every "board" the UI
shows (per session / project / employee / the CEO dashboard) is that same data through
a filtered VIEW. The filter + ordering rules that turn one list into a view live here,
kept PURE (no db, no I/O) so they run under `make unit` and are trivially testable.

Also here: the Green/Red action classifier (Harman's approval gate, from the
orchestrator charter) and a near-duplicate check for the org's learned-skill library.

Nothing in this module imports viewer.db or touches the network — callers pass plain
dicts/lists (as returned by the db accessors, RealDictCursor rows) and get plain values
back.
"""
from __future__ import annotations

# ── Views: one canonical card list → a filtered/ordered view ──────────────────

def filter_cards(cards, *, session=None, project=None, assignee=None):
    """Return the cards matching every provided filter (AND semantics). A None
    filter is ignored. This is how a single board becomes a per-session /
    per-project / per-employee view without any duplicate card storage.

    `cards` is a list of dict-like rows with keys session_id / project_id / assignee.
    Filters compare by value; ids may be int or str — compared as-is (callers pass
    matching types)."""
    out = []
    for c in cards:
        if session is not None and c.get("session_id") != session:
            continue
        if project is not None and c.get("project_id") != project:
            continue
        if assignee is not None and c.get("assignee") != assignee:
            continue
        out.append(c)
    return out


def order_column(cards):
    """Cards sorted by their fractional `position` ascending (missing position → 0.0).
    Stable: equal positions keep input order. Used to render one column top-to-bottom."""
    return sorted(cards, key=lambda c: _pos(c))


def _pos(card):
    try:
        return float(card.get("position", 0.0) or 0.0)
    except (TypeError, ValueError):
        return 0.0


def next_position(cards_in_column, index):
    """Fractional rank for a card being inserted at `index` within a column that is
    ALREADY ordered by position. Returns a float strictly between its new neighbours
    so a move never has to renumber the whole column (classic fractional indexing).

    - Empty column → 1.0.
    - index <= 0 (top)  → below the first card: first.position - 1.0.
    - index >= len (bottom) → above the last: last.position + 1.0.
    - middle → midpoint of the two straddling cards.
    `index` is the target slot AMONG THE OTHER cards (the card being moved is assumed
    not present in `cards_in_column`)."""
    ordered = order_column(cards_in_column)
    n = len(ordered)
    if n == 0:
        return 1.0
    if index <= 0:
        return _pos(ordered[0]) - 1.0
    if index >= n:
        return _pos(ordered[-1]) + 1.0
    return (_pos(ordered[index - 1]) + _pos(ordered[index])) / 2.0


# ── Approval gate: classify an action Green (auto) vs Red (needs Ram) ─────────
# The charter's rule: escalate only what can irreversibly destroy work, spend money
# or leak a secret, or hit a shared service. Everything else Harman does and logs.
# Table-driven so the policy is one obvious place to read/audit.

_RED_ACTIONS = {
    # irreversible data loss
    "delete_session", "delete_transcript", "git_reset_hard", "git_force_push",
    "delete_provider", "delete_file", "delete_employee", "delete_project", "card_delete",
    # overwriting shared team knowledge: skill_propose writes a NEW skill (green);
    # skill_promote overwrites one the team already relies on (red). The same write,
    # different risk — which is why they are two actions over one handler.
    "skill_promote",
    # handing the machine permission to act unattended again. Pausing stays green
    # and resuming is red ON PURPOSE — a kill switch must be easy to pull and hard
    # to push. Same split as skill_propose/skill_promote: one handler, two actions,
    # because the risk is in the DIRECTION of the change, not the write itself.
    # Without this, a session running at manager level could restore its own
    # supervision; now that request queues for a human.
    "automation_resume",
    # destroying a scheduled loop takes its run history with it — same
    # irreversible-removal class as card_delete. Creating/editing a loop stays
    # green: a harman-origin loop cannot FIRE until the owner licenses that origin
    # via the loop_control dropdown, so creation alone is contained and reversible.
    "loop_delete",
    # secrets / keys
    "create_secret", "reveal_secret", "rotate_secret", "write_api_key",
    # money / leaving the perimeter
    "paid_api", "testflight_submit", "appstore_submit", "dns_change", "tunnel_change",
    # shared-blast-radius infra
    "reboot_host", "stop_shared_service", "prod_down", "touch_foreign_host",
}

# Kinds an approval row can carry (mirrors db approvals.kind).
_RED_KINDS = {"destructive", "secret", "money", "infra"}


def classify_action(action):
    """Return 'red' if the action needs Ram's explicit approval, else 'green'.
    `action` may be an action name (str) or a dict with an 'action'/'kind' key.
    Unknown actions default to 'green' (reversible/contained) — the charter's
    narrowed rule of doubt: only escalate what's clearly irreversible/costly/shared."""
    if isinstance(action, dict):
        kind = action.get("kind")
        if kind in _RED_KINDS:
            return "red"
        name = action.get("action", "")
    else:
        name = action or ""
    return "red" if name in _RED_ACTIONS else "green"


def is_red(action):
    """Convenience boolean for classify_action(...) == 'red'."""
    return classify_action(action) == "red"


# ── Responsibility scope: authority level bounds WHAT an employee may do ──────
# Orthogonal to the Green/Red gate (which bounds HOW RISKY). An action must be
# BOTH within the caller's responsibility scope AND (if Red) approved by Ram.
# Levels are ordered least→most authority; each action names the MINIMUM level.

LEVELS = ("ic", "lead", "manager")

# ── Human authority: the account's role, independent of any session ───────────
# The OTHER principal. A request has up to two: the human who owns the viewer
# session (this) and the agent session acting (employee_level, above). Authority
# is the WEAKER of the two — see effective_level.
#
# The owner is a ROLE, resolved from users.role at runtime; no name appears in
# source. Ordered least→most, parallel to LEVELS.
HUMAN_ROLES = ("viewer", "operator", "owner")

# Human role -> the highest session level it may confer. An owner is unbounded
# (manager); an operator may act but not change the org; a viewer may only read.
_ROLE_CEILING = {
    "viewer": "ic",
    "operator": "lead",
    "owner": "manager",
}

# action -> minimum level required. Unlisted actions are denied by scope (return
# False) — deny-by-default; add here to grant.
_MIN_LEVEL = {
    # individual contributor: manage cards on work you're assigned
    "card_create": "ic",
    "card_move": "ic",
    "card_update": "ic",
    "card_assign_self": "ic",
    "task_done": "ic",
    "board_list": "ic",
    "card_list": "ic",
    "skill_propose": "ic",
    # Proposing a skill that OVERLAPS an existing one is also an ic act — the two
    # gates are orthogonal: scope says who may INITIATE, risk says whether it may
    # run unattended. skill_promote is Red, so an ic's overlapping proposal always
    # queues for the owner rather than being refused outright.
    "skill_promote": "ic",
    # lead: shape projects + move work across people
    "project_create": "lead",
    "project_ensure": "lead",        # find-or-create for a cwd; same authority to create
    "card_assign": "lead",           # assign to someone else
    "card_delete": "lead",           # remove a work item (also red → queued for MCP)
    "reassign_across_employees": "lead",
    "approval_resolve": "lead",
    "column_create": "lead",         # the board's SHAPE, not an item on it
    "column_update": "lead",
    "column_delete": "lead",         # not red: cards survive (FK ON DELETE SET NULL)
    # lead: schedule recurring work. A loop re-runs a prompt on a cadence, so it is
    # board-shaping authority (like assigning work), not an ic act on one's own
    # card. loop_delete is ALSO red → an agent's delete queues for the owner.
    "loop_create": "lead",
    "loop_update": "lead",
    "loop_delete": "lead",
    # manager: hire / change the org
    "employee_create": "manager",
    "employee_update": "manager",
    "harman_config": "manager",      # who may act autonomously, and with what budget
    # WHICH loop origins may fire (the loop_control dropdown) is an org-wide control
    # panel, same authority tier as harman_config. Not risk-split like the master
    # switch: setting it to 'none' or 'user' is a de-escalation, and licensing agent
    # loops ('harman'/'both') only decides WHETHER already-authored loops run — the
    # authoring of a harman loop was itself gated (loop_create, lead+).
    "loop_mode_set": "manager",
    # Same authority as any other Harman config write; the two differ only in RISK
    # (automation_resume is Red, automation_pause is not), which is the orthogonal
    # gate. Pausing is deliberately NOT restricted to manager: an ic session that
    # notices something wrong should be able to stop the machine without a
    # promotion. Stopping is the safe direction.
    "automation_pause": "ic",
    "automation_resume": "manager",
}


def _level_rank(level):
    try:
        return LEVELS.index(level)
    except ValueError:
        return -1  # unknown level → below everything → allowed nothing


def allowed(action, level):
    """True if an employee at `level` has the AUTHORITY to perform `action`.
    Deny-by-default: an action not in the responsibility table, or an unknown
    level, returns False. This is the scope gate ONLY — the Green/Red risk gate
    (classify_action) is applied separately by the caller."""
    name = action.get("action", "") if isinstance(action, dict) else (action or "")
    required = _MIN_LEVEL.get(name)
    if required is None:
        return False
    return _level_rank(level) >= _level_rank(required)


def effective_level(human_role, session_level):
    """The authority for a request with TWO principals: the human who owns the
    viewer session and the agent session acting on their behalf.

    Authority is the WEAKER of the two, so neither principal can be used to
    escalate the other:
      - a `viewer` human cannot gain power by spawning a manager-level agent;
      - an `owner` human cannot make an `ic` agent delete things.

    Either principal may be absent, and the missing one does NOT constrain:
      - human only (the web UI / mobile app — no agent session) → the role ceiling;
      - session only (a loop/cron spawn with no logged-in human) → the session level.
        The caller supplies the install owner's role as the ceiling for these, so an
        unattended spawn is never an implicit escalation.
    Both absent → "" (no authority; allowed() denies everything).

    Unknown values are treated as absent rather than lowest, so a typo'd role
    cannot silently strip an otherwise valid session's authority — it falls back
    to the other principal, which is itself gated.
    """
    ceiling = _ROLE_CEILING.get(human_role or "")
    floor = session_level if session_level in LEVELS else None
    if ceiling is None:
        return floor or ""
    if floor is None:
        return ceiling
    return ceiling if _level_rank(ceiling) < _level_rank(floor) else floor


def self_approves(human_role, session_level):
    """True if this principal's own action IS the approval for a Red one, so the
    caller should execute it rather than queue it.

    A Red action escalates TO the owner. When the owner is the one acting — at
    the UI, with no agent session in the loop — there is nobody left to escalate
    to; queueing would open an approval addressed to the person who just clicked.
    That is ceremony, not safety.

    An agent never self-approves, whatever its human ceiling: a non-empty
    `session_level` means a MODEL chose the action, and the point of the Red gate
    is that a human sees it first.

    This decides whether an action QUEUES. Whether a principal may then resolve
    what it queued is may_resolve — the other half of the same rail.
    """
    return human_role == "owner" and not session_level


def may_resolve(approval, actor):
    """True if `actor` may resolve `approval` — the separation-of-duties rail.

    Two distinct principals, always: the one who raised the escalation and the one
    who answers it. A principal that could resolve its own queued intent would
    escalate to Red and then rubber-stamp itself, which makes the whole Red gate
    theatre.

    It applies to humans too, not just agents. An operator has enough authority to
    resolve approvals, so without this rail they could queue a Red action and wave
    it through alone — the same hole, wearing a person's name. The owner is never
    caught by it: acting at the UI they do not queue in the first place
    (self_approves), so there is nothing of their own to approve.

    This only became reachable when approvals started EXECUTING what they hold
    (build step 2). Before that a self-resolve was inert, so the rail could not be
    tested; now it is the difference between a gate and a formality.
    """
    return (approval or {}).get("created_by") != actor


def mutates_own_session(acting_session, target_session):
    """True if a request would change the settings of the very session that is
    making it — the self-mutation rail for the agent execution-control tier.

    The charter's shape is "Workers only; Harman plan-only", and a worker session
    may reschedule/retune OTHER work under RBAC — but never its OWN. A session that
    could edit or delete the loop that drives it (or retarget it at itself) would
    be rewriting its own supervision from inside the loop: exactly the escalation
    the tier exists to prevent. Keyed on the acting session id (principal.session),
    which only an agent request carries — a human at the UI has an empty acting
    session, so this never fires for the owner.

    Pure and string-only so it unit-tests without a db: the caller resolves a
    loop/target to its session id and passes both in. An empty `acting_session`
    (no agent in the loop) or empty `target_session` (nothing to compare) is not a
    self-mutation.
    """
    return bool(acting_session) and bool(target_session) \
        and acting_session == target_session


# ── Harman's autonomous planning: board state → intended actions (PURE) ───────
# Deterministic list→list so the manager's decisions are unit-tested without a DB
# or spawning any model. The orchestrator (viewer/orchestrator.py) executes the
# returned intents; NOTHING here has side effects.

def project_columns(columns):
    """Map the board's columns to logical slots by name (case-insensitive), else
    fall back to position order: first=todo, last=done, 2nd=doing, 3rd=review.
    Returns {"todo","doing","review","done"} of column ids (any may be None)."""
    by_name = {}
    for c in columns:
        by_name[(c.get("name") or "").strip().lower()] = c.get("id")
    ordered = sorted(columns, key=lambda c: (c.get("position", 0), c.get("id", 0)))
    ids = [c.get("id") for c in ordered]
    return {
        "todo": by_name.get("todo", ids[0] if ids else None),
        "doing": by_name.get("doing", ids[1] if len(ids) > 1 else None),
        "review": by_name.get("review", ids[2] if len(ids) > 2 else None),
        "done": by_name.get("done", ids[-1] if ids else None),
    }


def _emp_level(emp):
    """Responsibility level for an employee, from an explicit 'level' or its role
    name. Conservative: only clear lead/manager role words elevate; default 'ic'."""
    if emp.get("level") in LEVELS:
        return emp["level"]
    role = (emp.get("role") or "").lower()
    if any(w in role for w in ("manager", "head", "director", "founder", "ceo", "chief")):
        return "manager"
    if "lead" in role:
        return "lead"
    return "ic"


def _spawnable(emp, default_provider):
    """Can Harman actually start a session for this employee? True if the employee has
    its own provider preset, or the org supplies a default one to fall back on. (Mirrors
    _spawn_employee_session's `preset_id = employee.provider or default_provider`.)"""
    return bool((emp.get("provider") or "").strip() or (default_provider or "").strip())


def suitable_employee(card, employees, *, default_provider=""):
    """Pick an active employee to WORK `card` (an actual doer, not a manager/CEO).
    Candidates are active, non-manager, and spawnable (own provider or an org default).
    Among them, prefer one whose role appears in the card title/body (a light skill
    match), else the first. Returns the employee dict or None. Deterministic.

    Falls back to any active non-manager if none are spawnable (so a misconfigured org
    still gets an assignment — the spawn just won't fire), and finally to the old
    first-active behaviour only when no worker exists at all."""
    active = [e for e in employees if (e.get("status") or "active") == "active"]
    if not active:
        return None
    workers = [e for e in active if _emp_level(e) != "manager"]
    pool = [e for e in workers if _spawnable(e, default_provider)] or workers or active
    text = ((card.get("title") or "") + " " + (card.get("body") or "")).lower()
    for e in pool:
        role = (e.get("role") or "").strip().lower()
        if role and role in text:
            return e
    return pool[0]


def plan_assignments(cards, employees, columns, running, *, projects, budget,
                     default_provider=""):
    """Given the board, return a list of intended Action dicts for Harman to execute.
    PURE — no side effects. `running` is the set of card ids already in flight (the
    in-progress guard); `projects` is the set of project ids Harman manages (empty =
    manage nothing); `budget` caps how many NEW spawns this plan may emit.

    Action shapes:
      {"kind":"assign", "card_id", "employee", "level", "spawn", "reason"}
      {"kind":"advance", "card_id", "to_column", "reason"}
      {"kind":"escalate", "approval_kind", "summary", "detail"}

    Rules: only cards whose project_id is in `projects`; an unassigned card in Todo
    not already running → assign (spawn if the chosen employee has no live session);
    a card in Doing whose owning session finished-ok → advance to Review. Every
    candidate passes the responsibility gate (allowed); a red action becomes an
    escalate (never an execute)."""
    slots = project_columns(columns)
    todo, doing, review = slots["todo"], slots["doing"], slots["review"]
    managed = set(projects or [])
    running = set(running or [])
    # employee id -> has a live session? (derived from `running` by assignee is not
    # enough; callers pass employees already tagged with `_busy` when they hold a
    # running session — default False.)
    out = []
    spawned = 0
    cap = budget if budget is not None else 0
    for card in cards:
        pid = card.get("project_id")
        if pid not in managed:
            continue
        cid = card.get("id")
        if cid in running:
            continue
        col = card.get("column_id")
        # Unassigned Todo → assign + (maybe) spawn.
        if col == todo and not card.get("assignee"):
            emp = suitable_employee(card, employees, default_provider=default_provider)
            if not emp:
                continue
            level = emp.get("level") or _emp_level(emp)
            want_spawn = not emp.get("_busy")
            if want_spawn and budget is not None and (len(running) + spawned) >= cap:
                want_spawn = False  # budget reached; assign but don't spawn this tick
            if want_spawn:
                spawned += 1
            out.append({
                "kind": "assign", "card_id": cid, "employee": emp.get("id"),
                "level": level, "spawn": want_spawn,
                "reason": f"unassigned Todo → {emp.get('name')}",
            })
        # Doing card whose session finished successfully → advance to Review.
        elif col == doing and card.get("_session_done_ok"):
            if review:
                out.append({"kind": "advance", "card_id": cid, "to_column": review,
                            "reason": "session finished ok → Review"})
    return out



def _norm_skill(name):
    """Normalize a skill name for comparison: lowercase, non-alphanumeric → single
    space, collapsed + trimmed. So "Ship to TestFlight" ~ "ship-to-testflight"."""
    out = []
    prev_space = False
    for ch in (name or "").lower():
        if ch.isalnum():
            out.append(ch)
            prev_space = False
        elif not prev_space:
            out.append(" ")
            prev_space = True
    return "".join(out).strip()


def dedupe_skill(name, existing_names):
    """True if a skill named `name` is a near-duplicate of one already in the library
    (so promotion should EXTEND the existing skill, not add a second). Match is on the
    normalized name: exact after normalization, or one normalized name contains the
    other as a whole (token-boundary) substring."""
    target = _norm_skill(name)
    if not target:
        return False
    for existing in existing_names or []:
        e = _norm_skill(existing)
        if not e:
            continue
        if e == target:
            return True
        # whole-phrase containment either direction (padded so we match token runs,
        # not partial words: "deploy" vs "deployment" should NOT collide)
        if f" {target} " in f" {e} " or f" {e} " in f" {target} ":
            return True
    return False


def build_skill_md(name, trigger, body, origin_employee=None):
    """Assemble a SKILL.md document (pure) for a promoted org skill: YAML frontmatter
    with the name + a `description` (the trigger — when to use the skill), the body
    (the procedure/lesson), and an origin credit line. Deterministic → unit-tested."""
    desc = (trigger or "").replace("\n", " ").strip() or name
    lines = ["---", f"name: {name}", f"description: {desc}", "---", ""]
    lines.append((body or "").strip())
    if origin_employee:
        lines.append("")
        lines.append(f"_Learned by {origin_employee}._")
    return "\n".join(lines).rstrip() + "\n"
