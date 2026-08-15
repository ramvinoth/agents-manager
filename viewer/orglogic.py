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
    "delete_provider", "delete_file", "delete_employee", "delete_project",
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


# ── Learned-skill dedup: keep the shared skill library clean ──────────────────

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
