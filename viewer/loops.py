"""viewer.loops — pure utility functions for the loop/job scheduler.

The actual loop_scheduler and run_loop_iteration live in engine.py.
This module exists so pure functions (parse_interval, cron_next_run)
can be unit-tested without importing the full engine.

Jobs support TWO scheduling modes:
  1. **interval** (legacy): run every N seconds, nextRun = now + interval.
  2. **cron**: a 5-field cron expression (minute hour dom month dow) evaluated
     in the server's local timezone. When `cron` is set it takes precedence;
     `interval` is ignored. The scheduler computes `nextRun` from the cron
     expression, so "daily at 09:00" stays locked to 09:00 — no drift.
"""
import re
import time
from datetime import datetime, timedelta
from typing import Optional, Set


def parse_interval(text):
    """'30s' / '5m' / '2h' / plain seconds -> seconds (min 30, max 24h)."""
    text = str(text).strip().lower()
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([smh]?)", text)
    if not m:
        return None
    val = float(m.group(1)) * {"": 1, "s": 1, "m": 60, "h": 3600}[m.group(2)]
    return int(min(max(val, 30), 86400))


# Loop-firing control. WHO may run scheduled loops right now, keyed off the
# loop_control setting's `mode`. Deliberately SEPARATE from the automation master
# switch (which gates only Harman's manager tick): the owner can pause Harman's
# autonomy while their own scheduled loops keep running, and vice-versa.
#
#   user   → only human-scheduled loops fire (the default; a fresh install runs
#            the owner's own loops but nothing an agent created)
#   harman → only agent-scheduled loops fire
#   both   → every loop fires
#   none   → nothing fires
#
# Pure (no db) so it unit-tests standalone and there is ONE definition of the
# mapping. An unknown/missing mode falls back to 'user' — the safe default that
# still honours the human's own schedules without licensing agent-made ones.
LOOP_MODES = ("user", "harman", "both", "none")
_MODE_ORIGINS = {
    "user": frozenset({"user"}),
    "harman": frozenset({"harman"}),
    "both": frozenset({"user", "harman"}),
    "none": frozenset(),
}


def allowed_origins(mode):
    """The set of loop origins permitted to fire under `mode`. Returns a frozenset
    (possibly empty, for 'none'). Unknown modes map to the 'user' default."""
    return _MODE_ORIGINS.get(mode, _MODE_ORIGINS["user"])


def build_schedule(cron_raw, interval_raw, now=None):
    """Validate a loop's schedule inputs → the storable schedule fields, or an error.

    Returns (fields, error): on success `fields` is {"cron", "interval", "nextRun"}
    ready to merge into a loop record and `error` is None; on bad input `fields` is
    None and `error` is a human-readable string. Shared by the human loop route and
    the gated agent loop action so the two can never drift on what a valid schedule
    is, or when it next fires.

    Cron wins over interval (matching the scheduler). `now` is injectable for tests
    and defaults to the wall clock. PURE apart from that clock read — no db, no I/O.
    """
    now = time.time() if now is None else now
    cron_expr = str(cron_raw or "").strip() or None
    if cron_expr:
        if not parse_cron(cron_expr):
            return None, "Invalid cron expression"
        return {"cron": cron_expr, "interval": 0,
                "nextRun": cron_next_run(cron_expr, now) or (now + 86400)}, None
    interval = parse_interval(interval_raw or "")
    if not interval:
        return None, "Provide a cron expression or interval (e.g. 30s, 5m, 1h)"
    return {"cron": None, "interval": interval, "nextRun": now + interval}, None


# ---------------------------------------------------------------------------
# Lightweight cron evaluator (no external deps)
# ---------------------------------------------------------------------------

def _parse_cron_field(field: str, lo: int, hi: int) -> Set[int]:
    """Parse one cron field into a set of matching integers.

    Supports: *, */N, N, N-M, N-M/S, and comma-separated combinations.
    """
    result: Set[int] = set()
    for part in field.split(","):
        part = part.strip()
        # */N  or  N-M/S
        if "/" in part:
            rng, step_s = part.split("/", 1)
            step = int(step_s)
            if rng == "*":
                start, end = lo, hi
            elif "-" in rng:
                a, b = rng.split("-", 1)
                start, end = int(a), int(b)
            else:
                start, end = int(rng), hi
            result.update(range(start, end + 1, step))
        elif part == "*":
            result.update(range(lo, hi + 1))
        elif "-" in part:
            a, b = part.split("-", 1)
            result.update(range(int(a), int(b) + 1))
        else:
            result.add(int(part))
    return result


def parse_cron(expr: str):
    """Parse a 5-field cron expression → (minutes, hours, doms, months, dows).

    Returns None on invalid input. Day-of-week: 0=Sun..6=Sat (also accepts 7=Sun).
    """
    parts = expr.strip().split()
    if len(parts) != 5:
        return None
    try:
        minutes = _parse_cron_field(parts[0], 0, 59)
        hours   = _parse_cron_field(parts[1], 0, 23)
        doms    = _parse_cron_field(parts[2], 1, 31)
        months  = _parse_cron_field(parts[3], 1, 12)
        dows    = _parse_cron_field(parts[4], 0, 7)
        # Normalise Sunday: 7 → 0
        if 7 in dows:
            dows.discard(7)
            dows.add(0)
        return (minutes, hours, doms, months, dows)
    except (ValueError, IndexError):
        return None


def _cron_matches(dt: datetime, parsed) -> bool:
    """Does `dt` match the parsed cron fields?"""
    minutes, hours, doms, months, dows = parsed
    if dt.minute not in minutes:
        return False
    if dt.hour not in hours:
        return False
    if dt.month not in months:
        return False
    # Standard cron: if BOTH dom and dow are restricted (not *), the event fires
    # when EITHER matches. If only one is restricted, it must match.
    dom_all = doms == set(range(1, 32))
    dow_all = dows == set(range(0, 7))
    if dom_all and dow_all:
        pass  # both are *, always matches
    elif dom_all:
        if dt.weekday() not in _iso_to_cron_dow(dows):
            return False
    elif dow_all:
        if dt.day not in doms:
            return False
    else:
        # Both restricted → OR semantics
        if dt.day not in doms and dt.weekday() not in _iso_to_cron_dow(dows):
            return False
    return True


def _iso_to_cron_dow(cron_dows: Set[int]) -> Set[int]:
    """Convert cron day-of-week (0=Sun) to Python weekday (0=Mon)."""
    mapping = {0: 6, 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5}
    return {mapping[d] for d in cron_dows if d in mapping}


def cron_next_run(expr: str, after: Optional[float] = None) -> Optional[float]:
    """Compute the next epoch timestamp when a cron expression fires.

    Searches minute-by-minute starting from `after` (default: now). Returns
    None if the expression is invalid. Caps the search at 366 days to prevent
    infinite loops on impossible expressions (e.g. Feb 31).
    """
    parsed = parse_cron(expr)
    if not parsed:
        return None
    start = datetime.fromtimestamp(after or time.time()).replace(second=0, microsecond=0)
    dt = start + timedelta(minutes=1)
    limit = start + timedelta(days=366)
    while dt < limit:
        if _cron_matches(dt, parsed):
            return dt.timestamp()
        dt += timedelta(minutes=1)
    return None
