"""viewer.orchestrator — the machine's two unattended-work controls.

  - `automation_enabled`: the master switch, default OFF. Nothing runs unattended
    until the owner turns it on, and turning it off pauses EVERY unattended path —
    see `automation_enabled()` below and its enforcement points in
    engine.loop_scheduler / engine.fire_due_loops.
  - loop control: WHICH loop origins may fire (user / harman / both / none).

Both live in the Postgres `settings` table (rows `harman` and `loop_control`).
There is no autonomous manager here any more: work reaches a session through a
card on its board (board_wake) or a loop someone scheduled, never through a
roster-matching planner (removed with the Employees roster, card 146).
"""
from viewer import db
from viewer import loops as _loops  # pure LOOP_MODES / allowed_origins mapping

_DEFAULT = {"automation_enabled": False}


def _load_config():
    cfg = dict(_DEFAULT)
    stored = db.setting_get("harman", {})
    # Defensive: only a dict row may override the default. A malformed value
    # (wrong shape, or a read that returns something other than a dict) leaves the
    # fail-safe default intact — automation stays OFF rather than crashing here.
    if isinstance(stored, dict):
        cfg["automation_enabled"] = bool(stored.get("automation_enabled", False))
    return cfg


def automation_enabled():
    """The master switch: may ANYTHING run unattended right now?

    Read fresh from the DB on every call, deliberately — a pause has to take effect
    within one scheduler pass, and a cached value would keep work running after the
    owner flipped the switch. The read is one indexed row and the caller ticks every 5s.

    Defaults FALSE. A missing row or a value that can't be read yields False,
    because `setting_get` falls back to `{}` and the default stands — the fail-safe
    direction for "is it safe to leave the machine alone" is off.
    """
    return _load_config()["automation_enabled"]


def get_config():
    """Public: the effective config (for the /api/org/harman route)."""
    return _load_config()


def set_automation(on):
    """The ONLY writer of the master switch: flipping it is always a distinct,
    individually-gated act (Red to resume, cheap to pause — see orglogic)."""
    db.setting_set("harman", {"automation_enabled": bool(on)})
    return _load_config()


# ── Loop control ────────────────────────────────────────────────────────────
# WHICH loop origins may fire, kept in its own `loop_control` settings row —
# a different FACT from the automation master switch, not a merged one: `mode`
# licenses origins, the switch is a runtime halt on the autonomous side (with
# it off, agent-origin loops don't fire; the owner's own loops follow the mode
# alone — a human's asking isn't paused by the machine being unattended). The
# scheduler reads both fresh each pass at ONE point (engine.fire_due_loops).

_LOOP_CONTROL_DEFAULT = {"mode": "user"}


def loop_mode():
    """The effective loop-firing mode: one of loops.LOOP_MODES. Read fresh from the
    DB each call (a change must take effect within one scheduler pass). A missing
    row or an unrecognised value yields the 'user' default — the safe fallback that
    still runs the owner's own loops but not agent-created ones."""
    row = db.setting_get("loop_control", {})
    mode = row.get("mode") if isinstance(row, dict) else None
    return mode if mode in _loops.LOOP_MODES else _LOOP_CONTROL_DEFAULT["mode"]


def get_loop_control():
    """Public: the effective loop-control config (for the /api/org/loop-control route)."""
    return {"mode": loop_mode()}


def set_loop_mode(mode):
    """Persist the loop-firing mode. Rejects anything not in loops.LOOP_MODES,
    falling back to the current effective mode so a bad value is inert rather than
    silently disabling every loop."""
    mode = mode if mode in _loops.LOOP_MODES else loop_mode()
    db.setting_set("loop_control", {"mode": mode})
    return get_loop_control()
