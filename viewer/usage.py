"""viewer.usage — first-party product usage: which controls are hot, which are dead.

The owner's own web and phone clients post small batches of events to the
owner's own server (POST /api/usage); nothing leaves the box. Agents read the
digest (GET /api/usage/report, MCP usage_report) to decide what to improve,
remove or move — the measuring half of the build → measure → change loop.

Event kinds:
  seen      a control was on screen (once per page load / screen visit)
  tap       a control was used
  view      a screen or dialog opened (element = "")
  feedback  the owner wrote a note about this surface (detail = the note)

Pure logic only (validation, the report shape) so it is unit-tested without a
database; db.py holds the SQL.
"""
import time

KINDS = ("seen", "tap", "view", "feedback")
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
        if not ev["surface"] or (ev["kind"] in ("seen", "tap") and not ev["element"]) \
                or (ev["kind"] == "feedback" and not ev["detail"]):
            dropped += 1
            continue
        ts = e.get("ts")
        ev["ts"] = float(ts) if isinstance(ts, (int, float)) and abs(ts - now) < _SKEW else now
        out.append(ev)
    return out, dropped + max(0, len(raw) - MAX_BATCH)


def report(rows, feedback, days, limit=25):
    """Shape db.ui_usage_rows into the digest an agent acts on.

    hot    controls by taps in the window (with how many times they were seen,
           so tap rate is visible);
    dead   controls seen at least `_DEAD_MIN_SEEN` times in the window and never
           tapped, ever — on screen, ignored: candidates to remove, merge or move;
    cold   controls tapped before the window and not in it — something changed
           (a control is cold OR dead, never both);
    screens  screen/dialog opens in the window.
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
        c = ctl.setdefault(key, {"client": key[0], "surface": key[1], "element": key[2],
                                 "taps": 0, "seen": 0, "taps_before": 0, "last_ts": 0})
        if r["kind"] == "tap":
            c["taps"] += r["n"]
            c["taps_before"] += r["n_before"]
            c["last_ts"] = max(c["last_ts"], r["last_ts"] or 0)
        elif r["kind"] == "seen":
            c["seen"] += r["n"]
    controls = list(ctl.values())
    hot = sorted((c for c in controls if c["taps"]), key=lambda c: -c["taps"])[:limit]
    dead = sorted((c for c in controls if not c["taps"] and not c["taps_before"]
                   and c["seen"] >= _DEAD_MIN_SEEN),
                  key=lambda c: -c["seen"])[:limit]
    cold = sorted((c for c in controls if not c["taps"] and c["taps_before"]),
                  key=lambda c: -c["taps_before"])[:limit]
    for c in hot + dead + cold:
        c.pop("last_ts", None)
    return {
        "days": days,
        "hot": hot,
        "dead": dead,
        "cold": cold,
        "screens": sorted(screens, key=lambda s: -s["opens"])[:limit],
        "feedback": feedback,
        "totals": {"controls": len(controls), "taps": sum(c["taps"] for c in controls)},
    }


# Seen this many times with zero taps before a control counts as dead: below
# it, "never used" is as likely to be "barely shown".
_DEAD_MIN_SEEN = 20
