"""Versioned, allowlisted display of recorded audit facts (never raw arguments).

No identity/resource joins: targets describe recorded references, not current
existence or access. New/unknown values fail closed to controlled display text.
"""
import math
import re
import unicodedata


# outcome -> (category, label, explanation). This is also the SQL filter authority.
# actions.execute audits `done` after ANY handler return, including error payloads.
_OUTCOMES = {
    "done": ("returned", "Handler returned",
             "The handler returned. This does not establish success or task completion; "
             "handlers can return error payloads."),
    "queued:red": ("queued", "Queued when recorded",
                   "The action was placed in the approval queue when recorded. "
                   "This does not describe its current approval state."),
    "denied:scope": ("denied", "Denied",
                     "The caller's effective authority did not allow this action."),
    # routes.orchestrator: guards before approval resolution / self mutation.
    "denied:self_resolve": ("denied", "Denied",
                            "The caller could not resolve an approval they raised."),
    "denied:self_mutation": ("denied", "Denied",
                             "The caller was blocked from changing their own session or loop controls."),
    "error:unknown_action": ("error", "Error recorded",
                             "No registered handler was found for the action."),
    # orchestrator.tick catches an exception for one planned action.
    "error": ("error", "Error recorded",
              "The manager tick recorded an exception while processing an action. "
              "This does not establish whether earlier changes occurred."),
    # Tick values intentionally stay Other, not handler-return / approval categories.
    "ok": ("other", "Tick returned",
           "The manager tick recorded 'ok' after its operation returned. "
           "This does not establish task completion."),
    "planned": ("other", "Dry-run plan recorded",
                "The manager tick recorded a proposed action in dry-run mode, "
                "without executing that action."),
    "pending": ("other", "Approval opened when recorded",
                "The manager tick opened an approval when recorded. "
                "This does not describe its current approval state."),
    "no_provider": ("other", "No session returned",
                    "The manager tick recorded no session identifier for a spawn attempt. "
                    "This record alone does not identify the cause."),
    # questions.persist and board_wake._wake respectively.
    "asked": ("other", "Question recorded",
              "An owner question was persisted when recorded. "
              "This does not say whether it has since been answered."),
    "queued": ("other", "Wake queued when recorded",
               "A board wake was scheduled when recorded. "
               "This does not establish that it ran or remains scheduled."),
}
_OTHER = ("other", "Other recorded result",
          "No supported result meaning is available for this record.")
RESULT_CATEGORIES = ("all", "returned", "queued", "denied", "error", "other")
# Limits of this API contract, not claims about database or platform capacity.
MAX_LIMIT = 100
MAX_ID = 2**53 - 1  # references must round-trip through the JSON-number client


def outcome_filter(result):
    """Return a parameterized SQL predicate and params using projection's mapping."""
    if result not in RESULT_CATEGORIES:
        raise ValueError("Unsupported audit result")
    if result == "all":
        return "", []
    values = [value for value, spec in _OUTCOMES.items()
              if (spec[0] != "other" if result == "other" else spec[0] == result)]
    placeholders = ", ".join("%s" for _ in values)
    if result == "other":
        return f"(outcome IS NULL OR outcome NOT IN ({placeholders}))", values
    return f"outcome IN ({placeholders})", values


# Controlled action labels describe the requested operation, not its success.
# References are action-specific: (label, intent arg key, direct-writer key).
# actions.ACTIONS owns intent keys; orchestrator.tick / board_wake own direct keys.
_ACTIONS = {
    "card_create": ("Create card", ("Project", "project_id", None)),
    "card_update": ("Update card", ("Card", "card_id", None)),
    "card_move": ("Move card", ("Card", "card_id", None)),
    "card_assign": ("Assign card", ("Card", "card_id", "card")),
    "card_delete": ("Delete card", ("Card", "card_id", None)),
    "card_comment": ("Comment on card", ("Card", "card_id", None)),
    "card_dep_add": ("Add card dependency", ("Card", "card_id", None)),
    "card_dep_remove": ("Remove card dependency", ("Card", "card_id", None)),
    "task_done": ("Mark card done", ("Card", "card_id", None)),
    "column_create": ("Create board column", ("Project", "project_id", None)),
    "column_update": ("Update board column", ("Column", "id", None)),
    "column_delete": ("Delete board column", ("Column", "id", None)),
    "project_create": ("Create project", None),
    "project_ensure": ("Find or create project", None),
    "employee_create": ("Create employee", None),
    "employee_update": ("Update employee", ("Employee", "id", None)),
    "harman_config": ("Change manager configuration", None),
    "automation_pause": ("Pause automation", None),
    "automation_resume": ("Resume automation", None),
    "approval_resolve": ("Resolve approval", ("Approval", "id", "id")),
    "loop_create": ("Create scheduled work", None),
    "loop_update": ("Update scheduled work", None),
    "loop_delete": ("Delete scheduled work", None),
    "loop_mode_set": ("Change loop firing mode", None),
    "session_mode_set": ("Change session permission mode", None),
    "system_preamble_set": ("Change system preamble", None),
    "skill_propose": ("Propose shared skill", None),
    "skill_promote": ("Promote shared skill", None),
    "self_mutation": ("Change own session controls", None),
    "tick_dryrun": ("Plan manager action", None),
    "card_advance": ("Advance card", ("Card", None, "card")),
    "spawn_session": ("Start employee session", ("Card", None, "card")),
    "escalate": ("Request owner approval", ("Approval", None, "approval")),
    "ask_owner": ("Ask owner a question", None),
    "board_wake": ("Schedule board wake", ("Card", None, "card")),
}


def _positive_id(value):
    return type(value) is int and 0 < value <= MAX_ID


def _actor(value):
    if not isinstance(value, str):
        return "Unknown actor"
    # Strip control/format/surrogate characters (including bidi overrides), fold
    # whitespace, and cap output. Never stringify structured or arbitrary objects.
    text = "".join(" " if c.isspace() else c
                   for c in value[:1024] if c.isspace() or unicodedata.category(c)[0] != "C")
    return " ".join(text.split())[:120] or "Unknown actor"


def _target(action, reference, target):
    fallback = {"label": "Target not available"}
    if reference is None or not isinstance(target, dict):
        return fallback
    label, intent_key, direct_key = reference
    if "args" in target or "action" in target:
        if target.get("action") != action or not isinstance(target.get("args"), dict):
            return fallback
        value = target["args"].get(intent_key) if intent_key else None
    else:
        value = target.get(direct_key) if direct_key else None
    if not _positive_id(value):
        return fallback
    return {"label": f"{label} #{value}", **({"card_id": value} if label == "Card" else {})}


def project_entry(row):
    """Project one stored row. Only actor text and validated numeric facts pass through."""
    action = row.get("action")
    label, reference = _ACTIONS.get(action, ("Recorded action", None)) if isinstance(action, str) else (
        "Recorded action", None)
    outcome = row.get("outcome")
    category, result_label, explanation = _OUTCOMES.get(outcome, _OTHER) if isinstance(outcome, str) else _OTHER
    timestamp = row.get("created_at")
    # ECMAScript Date range, seconds (db._now). Excludes NaN, infinities and
    # corrupted huge integers before float conversion; no truthy bool timestamps.
    if type(timestamp) not in (int, float) or not 0 <= timestamp <= 8_640_000_000_000 or not math.isfinite(timestamp):
        timestamp = None
    return {"id": row["id"], "actor": _actor(row.get("actor")), "action": label,
            "target": _target(action, reference, row.get("target")),
            "result": {"category": category, "label": result_label, "explanation": explanation},
            "created_at": timestamp}


def display_options(query):
    """Strict display-v1 query validation; callers preserve blank/repeated values."""
    def one(key, default):
        values = query.get(key, [default])
        if len(values) != 1:
            raise ValueError("Audit query parameters must occur once")
        return values[0]

    def integer(value, maximum):
        if not isinstance(value, str) or len(value) > 16 or not re.fullmatch(r"[0-9]+", value):
            raise ValueError("Audit limit and before must be positive integers")
        parsed = int(value)
        if not 0 < parsed <= maximum:
            raise ValueError("Audit limit or before is outside the supported range")
        return parsed

    if one("view", None) != "display-v1":
        raise ValueError("Unsupported audit view")
    limit = integer(one("limit", "50"), MAX_LIMIT)
    before = one("before", None)
    before_id = integer(before, MAX_ID) if before is not None else None
    result = one("result", "all")
    if result not in RESULT_CATEGORIES:
        raise ValueError("Unsupported audit result")
    return limit, before_id, result
