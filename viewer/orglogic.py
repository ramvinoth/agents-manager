"""viewer.orglogic — pure org/Kanban logic for the orchestrator ("Harman").

The empire runs on ONE canonical board: a single `cards` list. Every "board" the UI
shows (per session / project / the CEO dashboard) is that same data through
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

def filter_cards(cards, *, session=None, project=None):
    """Return the cards matching every provided filter (AND semantics). A None
    filter is ignored. This is how a single board becomes a per-session /
    per-project view without any duplicate card storage.

    `cards` is a list of dict-like rows with keys session_id / project_id.
    Filters compare by value; ids may be int or str — compared as-is (callers pass
    matching types)."""
    out = []
    for c in cards:
        if session is not None and c.get("session_id") != session:
            continue
        if project is not None and c.get("project_id") != project:
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


# The claude CLI permission modes a session's runs may start in. One vocabulary,
# referenced from three places: engine (applies it to the spawned run),
# actions (validates a session_mode_set write) and the route/MCP schema
# (documents it). 'bypass' is the escalation direction — the run goes up with
# --dangerously-skip-permissions, no tool gated.
PERMISSION_MODES = ("default", "acceptEdits", "plan", "bypass")


# ── Approval gate: classify an action Green (auto) vs Red (needs the owner) ─────────
# The charter's rule: escalate only what can irreversibly destroy work, spend money
# or leak a secret, or hit a shared service. Everything else Harman does and logs.
# Table-driven so the policy is one obvious place to read/audit.

_RED_ACTIONS = {
    # irreversible data loss
    "delete_session", "delete_transcript", "git_reset_hard", "git_force_push",
    "delete_provider", "delete_file", "project_delete", "card_delete",
    "note_delete",
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
    # restarting the server outside the maintenance window cuts every running
    # agent turn off at a moment nobody planned (viewer.maintenance). Queueing a
    # restart for the window is green (restart_request); doing it NOW is the
    # owner's call.
    "restart_now",
    # rewriting the global system preamble injects instructions into EVERY future
    # session's system prompt (engine.append_system_prompt) — fleet-wide reach, the
    # same "overwrites what the whole team relies on" class as skill_promote. An
    # agent's attempt queues for the owner; the owner at the UI self-approves.
    "system_preamble_set",
    # delegation of authority: sets the permission mode a session's runs start in.
    # 'bypass' hands ONE session full unattended machine access (the next run goes
    # up with --dangerously-skip-permissions), the same "hands the machine
    # permission" class as automation_resume — only narrower (one session, not the
    # whole loop fleet). An agent's request therefore always queues for the owner;
    # the owner at the UI self-approves (he is the one delegating).
    "session_mode_set",
    # the Harman-side twin of session_mode_set: sets the authority LEVEL a
    # session acts at on the board (ic/lead/manager). Same delegation class —
    # a model can never raise its own (or a peer's) authority unattended.
    "session_level_set",
    # destroying a scheduled loop takes its run history with it — same
    # irreversible-removal class as card_delete. Creating/editing a loop stays
    # green: a harman-origin loop cannot FIRE until the owner licenses that origin
    # via the loop_control dropdown, so creation alone is contained and reversible.
    "loop_delete",
    # a new door from outside the org onto a board, and a fresh key to it
    "intake_create", "intake_rotate",
    # secrets / keys
    "create_secret", "reveal_secret", "rotate_secret", "write_api_key",
    # money / leaving the perimeter
    "paid_api", "testflight_submit", "appstore_submit", "dns_change", "tunnel_change",
    # shared-blast-radius infra
    "reboot_host", "stop_shared_service", "prod_down", "touch_foreign_host",
}

# What the owner risks by approving, in one plain line — shown with the approval
# in the decision queue so a cold reader can judge it without knowing the policy
# above. Only actions an agent can actually queue need an entry; anything else
# falls back to RED_RISK_DEFAULT.
RED_RISK = {
    "card_delete": "The card and its whole comment thread are deleted for good.",
    "note_delete": "The note and its discussion are deleted for good.",
    "project_delete": "The board and its columns are deleted for good; its cards and notes "
                      "move to the project named, and its intake channels close.",
    "loop_delete": "The scheduled work and its run history are deleted for good.",
    "skill_promote": "Overwrites a skill every session already relies on.",
    "automation_resume": "Agents may start running unattended work again.",
    "restart_now": "Restarts the server now: every running agent turn is cut off mid-work.",
    "system_preamble_set": "Changes the instructions every future session starts with.",
    "session_mode_set": "Changes how much that session may do without asking; "
                        "'bypass' lets it run any command on this machine unattended.",
    "session_level_set": "Changes what that session may do on the board on its own: "
                         "'lead' lets it schedule work and delete cards, 'manager' lets it change org settings.",
    "intake_create": "Opens a new door from outside onto a board: anyone with its token can create cards.",
    "intake_rotate": "Issues a new token for the channel; the old one stops working.",
}
RED_RISK_DEFAULT = "This action is hard to undo or reaches beyond one session."


# Kinds an approval row can carry (mirrors db approvals.kind).
_RED_KINDS = {"destructive", "secret", "money", "infra"}


def classify_action(action):
    """Return 'red' if the action needs the owner's explicit approval, else 'green'.
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


# ── Responsibility scope: authority level bounds WHAT a session may do ────────
# Orthogonal to the Green/Red gate (which bounds HOW RISKY). An action must be
# BOTH within the caller's responsibility scope AND (if Red) approved by the owner.
# Levels are ordered least→most authority; each action names the MINIMUM level.

LEVELS = ("ic", "lead", "manager")
# What a person reads for each level — named by REACH (how far a session may
# act unsupervised), never by job title, so it can't be confused with an agent
# (e.g. the "Product Manager" agent). The keys ic/lead/manager stay on the wire;
# these are display only. "Own work" = its own cards, notes and messages;
# "Workspace" = also projects, columns and scheduled loops; "Organization" =
# also org-wide settings. A second gate (Red) still sends anything destructive
# or paid to the owner regardless of level.
LEVEL_NAMES = {"ic": "Own work", "lead": "Workspace", "manager": "Organization"}

# ── Human authority: the account's role, independent of any session ───────────
# The OTHER principal. A request has up to two: the human who owns the viewer
# session (this) and the agent session acting (its level, above). Authority
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
    # individual contributor: manage cards on one's own board
    "card_create": "ic",
    "card_move": "ic",
    "card_update": "ic",
    "card_comment": "ic",          # discussion on one's own board — green, never red
    "card_dep_add": "ic",          # dependency edges are work-shaping on one's own
    "card_dep_remove": "ic",       # cards (add+remove are both reversible) — green
    "note_create": "ic",           # one's own notes: the knowledge ledger next to cards
    "note_update": "ic",           # (archive/unarchive is a reversible field write)
    "note_delete": "ic",           # irreversible → red, so an agent's delete queues
    "note_comment": "ic",          # the discussion under a note — green, like card_comment
    "note_vote": "ic",             # one vote per voter, reversible — green
    "inbox_send": "ic",           # one's own messages: the ledger next to the notes;
                                  # green — a message is communication, never a mutation
    "task_done": "ic",
    "board_list": "ic",
    "card_list": "ic",
    "skill_propose": "ic",
    # Proposing a skill that OVERLAPS an existing one is also an ic act — the two
    # gates are orthogonal: scope says who may INITIATE, risk says whether it may
    # run unattended. skill_promote is Red, so an ic's overlapping proposal always
    # queues for the owner rather than being refused outright.
    "skill_promote": "ic",
    # lead: shape projects and the board
    "project_create": "lead",
    "project_ensure": "lead",        # find-or-create for a cwd; same authority to create
    "project_delete": "lead",        # remove a board (also red → queued for MCP)
    "card_delete": "lead",           # remove a work item (also red → queued for MCP)
    "approval_resolve": "lead",
    "column_create": "lead",         # the board's SHAPE, not an item on it
    "column_update": "lead",
    "column_delete": "lead",         # not red: cards survive (FK ON DELETE SET NULL)
    # lead: schedule recurring work. A loop re-runs a prompt on a cadence, so it is
    # board-shaping authority, not an ic act on one's own
    # card. loop_delete is ALSO red → an agent's delete queues for the owner.
    "loop_create": "lead",
    # Starting a new worker session spends runs like a loop does, so the same
    # authority. Bypass mode is refused at the route (session_mode_set is the door).
    "session_create": "lead",
    "loop_update": "lead",
    "loop_delete": "lead",
    # lead: intake channels — inbound doors from the outside world onto a board
    # (viewer.intake). Opening one or minting a new token is ALSO red: it lets
    # outside text create cards and wake a session, the "leaving the perimeter"
    # class. Renaming/rebinding and closing a door stay green — closing is the
    # safe direction (the automation_pause rule).
    "intake_create": "lead",
    "intake_rotate": "lead",
    "intake_update": "lead",
    "intake_delete": "lead",
    # manager: change the org
    # WHICH loop origins may fire (the loop_control dropdown) is an org-wide control
    # panel. Not risk-split like the master
    # switch: setting it to 'none' or 'user' is a de-escalation, and licensing agent
    # loops ('harman'/'both') only decides WHETHER already-authored loops run — the
    # authoring of a harman loop was itself gated (loop_create, lead+).
    "loop_mode_set": "manager",
    # The global system-awareness preamble is org-wide config (it shapes every
    # session), so it is manager scope like loop_mode_set. It is ALSO Red (above):
    # scope says who may initiate, risk says whether it runs unattended.
    "system_preamble_set": "manager",
    # Same authority as any other Harman config write; the two differ only in RISK
    # (automation_resume is Red, automation_pause is not), which is the orthogonal
    # gate. Pausing is deliberately NOT restricted to manager: an ic session that
    # notices something wrong should be able to stop the machine without a
    # promotion. Stopping is the safe direction.
    "automation_pause": "ic",
    "automation_resume": "manager",
    # Any session may REQUEST a change to a session's permission mode (ic scope,
    # like asking for a loop) — but the action is Red, so the request ALWAYS
    # queues for the owner and a model can never grant itself trust: the scope
    # gate decides who may initiate, the risk gate decides who must consent.
    "session_mode_set": "ic",
    # Same shape for the Harman authority level (session_level_set is Red).
    "session_level_set": "ic",
    # Any session that changed server code may ask for the next maintenance
    # window; restart_now is the same request without the wait, so the scope is
    # the same and the Red gate (above) is what makes an agent's ask queue.
    "restart_request": "ic",
    "restart_now": "ic",
}


def _level_rank(level):
    try:
        return LEVELS.index(level)
    except ValueError:
        return -1  # unknown level → below everything → allowed nothing


def allowed(action, level):
    """True if a session at `level` has the AUTHORITY to perform `action`.
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


# ── Board shape: which project / which column (PURE) ──────────────────────────

def resolve_board_project(explicit=None, session_project=None):
    """Which project's board a board-view or card belongs to — the ONE rule every
    board path applies: an explicit project (the caller names it) wins; else the
    session's own bound project (`kanbanProject`, set when the engine spawns the
    session); else None — the card/view has no board until one is attached.

    Pure over raw values: both arguments may be int or the JSON string form
    (session_meta stores it as a string). Every caller that needs a project id
    runs this instead of re-deriving the rule, so the board read, card create,
    and card detail can never disagree about which board a card is on."""
    if explicit not in (None, ""):
        return int(explicit)
    if session_project not in (None, ""):
        return int(session_project)
    return None


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


# The default pipeline every project's board is seeded with (db.project_create)
# and guaranteed present by ensure_pipeline_columns. "Review" is the holding
# state for work that needs the owner's decision; "Approved"/"Declined" are the
# owner's DECISION states — the human drags the card between them and the card's
# session is woken to act (boardwatch). "Blocked" (a dependency is not done) and
# "Needs-info" (waiting on the owner for a fact or a decision) are the states a
# WORKER moves its own card into and comments on the card about — the comment
# pushes to the owner, the worker's own move never wakes itself. "Done" stays
# LAST: _task_done and the position fallbacks in project_columns both key on
# the last column.
PIPELINE_COLUMNS = ("Todo", "Doing", "Review", "Approved", "Declined",
                    "Blocked", "Needs-info", "Done")


def ensure_pipeline_columns(columns):
    """What must exist so a project's board carries the default pipeline.

    PURE. Input: the project's current columns (db.board_columns_list rows).
    Output: a list of {"id", "name", "position"} — one entry per pipeline slot,
    in canonical order, where `id` is the existing column's id (rename to this
    name already matched; position may change) or None (column to create) — plus
    one untouched passthrough entry per CUSTOM column (a name that matches no
    pipeline slot), in original order.

    Name is the contract, exactly like project_columns: a column whose name
    (case-insensitive) is a pipeline name TAKES the pipeline's canonical
    position, even if the owner placed it elsewhere — the UI and the
    name-resolvers see one board shape. Custom columns keep whatever position
    the owner gave them; an entry absent from the returned list is one this
    function does not touch (e.g. a duplicate of a pipeline name). Idempotent:
    feeding the output back in returns the same list.
    """
    by_name = {}
    for c in columns:
        key = (c.get("name") or "").strip().lower()
        if key:
            by_name.setdefault(key, c)
    out = []
    matched = set()
    for i, name in enumerate(PIPELINE_COLUMNS):
        key = name.lower()
        existing = by_name.get(key)
        if existing is None:
            out.append({"id": None, "name": name, "position": i})
        else:
            matched.add(key)
            out.append({"id": existing.get("id"), "name": existing.get("name"),
                        "position": i})
    for c in columns:
        key = (c.get("name") or "").strip().lower()
        if key and key not in matched:
            out.append({"id": c.get("id"), "name": c.get("name"),
                        "position": c.get("position", 0)})
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


def build_skill_md(name, trigger, body, learned_by=None):
    """Assemble a SKILL.md document (pure) for a promoted org skill: YAML frontmatter
    with the name + a `description` (the trigger — when to use the skill), the body
    (the procedure/lesson), and an origin credit line. Deterministic → unit-tested."""
    desc = (trigger or "").replace("\n", " ").strip() or name
    lines = ["---", f"name: {name}", f"description: {desc}", "---", ""]
    lines.append((body or "").strip())
    if learned_by:
        lines.append("")
        lines.append(f"_Learned by {learned_by}._")
    return "\n".join(lines).rstrip() + "\n"
