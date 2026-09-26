"""Versioned, allowlisted display of recorded audit facts (never raw arguments).

project_entry is pure: targets describe recorded references (ids), not current
existence. The route then names those references (card titles, column names)
through `name_references`, so a person reads "Moved 'Ship the editor' to Review"
instead of "Card #44 / column 40". New/unknown values fail closed to controlled
display text; free-text arguments (comment bodies, patches) never pass through.
"""
import math
import re
import unicodedata


# outcome -> (category, label, explanation). This is also the SQL filter authority.
# actions.execute audits `done` after ANY handler return, including error payloads.
_OUTCOMES = {
    "done": ("returned", "Ran",
             "The handler ran and returned. Its own reply is not recorded here, so this "
             "alone does not prove the change took effect."),
    "queued:red": ("queued", "Sent for approval",
                   "This action needs the owner's approval and was placed in the queue. "
                   "Whether it was later approved is not part of this record."),
    "denied:scope": ("denied", "Denied",
                     "The caller's authority did not allow this action."),
    # routes.orchestrator: guards before approval resolution / self mutation.
    "denied:self_resolve": ("denied", "Denied",
                            "The caller tried to resolve an approval they raised themselves."),
    "denied:self_mutation": ("denied", "Denied",
                             "The caller tried to change its own session or loop controls."),
    "error:unknown_action": ("error", "Failed",
                             "No handler is registered for this action."),
    # orchestrator.tick catches an exception for one planned action.
    "error": ("error", "Failed",
              "The manager tick hit an exception while processing this action."),
    # Tick values intentionally stay Other, not handler-return / approval categories.
    "ok": ("other", "Tick ran",
           "The manager tick finished this operation."),
    "planned": ("other", "Planned (dry run)",
                "The manager tick proposed this action in dry-run mode and did not execute it."),
    "pending": ("other", "Approval opened",
                "The manager tick opened an approval for the owner. Whether it was decided "
                "is not part of this record."),
    "no_provider": ("other", "No session started",
                    "The manager tick got no session identifier back from a spawn attempt."),
    # questions.persist and board_wake._wake respectively.
    "asked": ("other", "Question asked",
              "A question for the owner was saved. Whether it has been answered is not part "
              "of this record."),
    "queued": ("other", "Wake scheduled",
               "A board wake was scheduled for a session."),
}
_OTHER = ("other", "Unknown result",
          "This record carries a result this version cannot interpret.")
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
        args = target["args"]
        value = args.get(intent_key) if intent_key else None
    else:
        args = {}
        value = target.get(direct_key) if direct_key else None
    if not _positive_id(value):
        return fallback
    out = {"label": f"{label} #{value}", **({"card_id": value} if label == "Card" else {})}
    # A move is meaningless without its destination; the column id is the only
    # other argument that is a validated reference rather than free text.
    if action == "card_move" and _positive_id(args.get("column_id")):
        out["column_id"] = args["column_id"]
    return out


def name_references(entries, card_titles, column_names):
    """Attach current names to the validated ids in projected entries, in place.

    `card_titles(ids) -> {id: title}` and `column_names(ids) -> {id: name}` are
    injected (db functions in production) so the projection stays testable
    without a database. A reference to a deleted row simply keeps its number.
    """
    cards = {e["target"]["card_id"] for e in entries if "card_id" in e["target"]}
    columns = {e["target"]["column_id"] for e in entries if "column_id" in e["target"]}
    titles = card_titles(sorted(cards)) if cards else {}
    names = column_names(sorted(columns)) if columns else {}
    for e in entries:
        t = e["target"]
        if "card_id" in t and isinstance(titles.get(t["card_id"]), str):
            t["title"] = titles[t["card_id"]]
        if "column_id" in t and isinstance(names.get(t["column_id"]), str):
            t["column"] = names[t["column_id"]]
    return entries


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
