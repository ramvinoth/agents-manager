"""orchestrator.usage — first-party product usage: which controls are hot, which are dead.

The owner's own web and phone clients post small batches of events to the
owner's own server (POST /api/usage); nothing leaves the box. Agents read the
digest (GET /api/usage/report, MCP usage_report) to decide what to improve,
remove or move — the measuring half of the build → measure → change loop.

Event kinds:
  seen        a control was on screen (once per page load / screen visit)
  tap         a control was pressed
  long_press  a control was long-pressed (phone)
  swipe       a swipe gesture completed (phone; element = the gesture's name)
  view        a screen or dialog opened (element = "")
  feedback    the owner wrote a note about this surface (detail = the note)

Pure logic only (validation, the report shape) so it is unit-tested without a
database; db.py holds the SQL.
"""
import time

# A use of a control: every gesture that acts on it counts, not only a tap.
USE_KINDS = ("tap", "long_press", "swipe")
# The report's per-gesture field for each use kind.
_USE_FIELD = {"tap": "taps", "long_press": "long_presses", "swipe": "swipes"}
KINDS = ("seen",) + USE_KINDS + ("view", "feedback")
CLIENTS = ("web", "ios")
MAX_BATCH = 200
_FIELD_MAX = {"surface": 80, "element": 80, "detail": 2000}
# A client clock may drift; an event stamped far outside "now" is the clock's
# fault, so the server's time replaces it rather than rejecting the event.
_SKEW = 7 * 86400


def clean_events(raw, client, now=None):
    """Validate one posted batch. Returns (events, dropped): events ready for
    db.ui_events_insert, and how many were refused. Unknown kinds, missing
    names and over-long batches are dropped, never stored half-formed."""
    now = time.time() if now is None else now
    if client not in CLIENTS or not isinstance(raw, list):
        return [], len(raw) if isinstance(raw, list) else 0
    out, dropped = [], 0
    for e in raw[:MAX_BATCH]:
        if not isinstance(e, dict) or e.get("kind") not in KINDS:
            dropped += 1
            continue
        ev = {"client": client, "kind": e["kind"]}
        for f, cap in _FIELD_MAX.items():
            v = e.get(f)
            ev[f] = v.strip()[:cap] if isinstance(v, str) else ""
        if not ev["surface"] or (ev["kind"] in ("seen",) + USE_KINDS and not ev["element"]) \
                or (ev["kind"] == "feedback" and not ev["detail"]):
            dropped += 1
            continue
        ts = e.get("ts")
        ev["ts"] = float(ts) if isinstance(ts, (int, float)) and abs(ts - now) < _SKEW else now
        out.append(ev)
    return out, dropped + max(0, len(raw) - MAX_BATCH)


def report(rows, feedback, days, limit=25):
    """Shape db.ui_usage_rows into the digest an agent acts on.

    A control's `uses` are its taps, long-presses and swipes together (each is
    also reported on its own, so a control used only by long-press is not dead).
    hot    controls by uses in the window (with how many times they were seen,
           so the use rate is visible);
    dead   controls seen at least `_DEAD_MIN_SEEN` times in the window and never
           used, ever — on screen, ignored: candidates to remove, merge or move;
    cold   controls used before the window and not in it — something changed
           (a control is cold OR dead, never both);
    screens  screen/dialog opens in the window.
    Web and phone rows stay apart (`client`): one name on both is two controls.
    """
    ctl = {}
    screens = []
    for r in rows:
        key = (r["client"], r["surface"], r["element"])
        if r["kind"] == "view":
            if r["n"]:
                screens.append({"client": r["client"], "surface": r["surface"], "opens": r["n"],
                                "people": r["actors"]})
            continue
        c = ctl.get(key)
        if c is None:
            c = ctl[key] = {"client": key[0], "surface": key[1], "element": key[2],
                            "uses": 0, "seen": 0, "uses_before": 0}
            c.update((f, 0) for f in _USE_FIELD.values())
        if r["kind"] in _USE_FIELD:
            c[_USE_FIELD[r["kind"]]] += r["n"]
            c["uses"] += r["n"]
            c["uses_before"] += r["n_before"]
        elif r["kind"] == "seen":
            c["seen"] += r["n"]
    controls = list(ctl.values())
    hot = sorted((c for c in controls if c["uses"]), key=lambda c: -c["uses"])[:limit]
    dead = sorted((c for c in controls if not c["uses"] and not c["uses_before"]
                   and c["seen"] >= _DEAD_MIN_SEEN),
                  key=lambda c: -c["seen"])[:limit]
    cold = sorted((c for c in controls if not c["uses"] and c["uses_before"]),
                  key=lambda c: -c["uses_before"])[:limit]
    totals = {"controls": len(controls), "uses": sum(c["uses"] for c in controls)}
    totals.update((f, sum(c[f] for c in controls)) for f in _USE_FIELD.values())
    return {
        "days": days,
        "hot": hot,
        "dead": dead,
        "cold": cold,
        "screens": sorted(screens, key=lambda s: -s["opens"])[:limit],
        "feedback": feedback,
        "totals": totals,
    }


# Seen this many times with zero taps before a control counts as dead: below
# it, "never used" is as likely to be "barely shown".
_DEAD_MIN_SEEN = 20
