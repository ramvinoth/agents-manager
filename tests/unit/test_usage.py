"""viewer.usage: batch validation and the hot/dead/cold digest (pure, no DB)."""
from viewer import usage

NOW = 1_800_000_000.0


def test_clean_keeps_valid_and_counts_dropped():
    raw = [
        {"kind": "tap", "surface": "kanban", "element": "move-to", "ts": NOW - 5},
        {"kind": "seen", "surface": "kanban", "element": ""},       # seen needs an element
        {"kind": "view", "surface": "inbox"},                        # view needs no element
        {"kind": "feedback", "surface": "inbox", "detail": "  "},     # empty note
        {"kind": "hack", "surface": "x", "element": "y"},             # unknown kind
        "not a dict",
    ]
    events, dropped = usage.clean_events(raw, "web", now=NOW)
    assert [e["kind"] for e in events] == ["tap", "view"]
    assert dropped == 4
    assert events[0]["ts"] == NOW - 5 and events[0]["client"] == "web"


def test_clean_rejects_unknown_client_and_non_list():
    assert usage.clean_events([{"kind": "view", "surface": "a"}], "android", now=NOW) == ([], 1)
    assert usage.clean_events({"kind": "view"}, "web", now=NOW) == ([], 0)
    assert usage.clean_events(None, "ios", now=NOW) == ([], 0)


def test_clean_caps_fields_batch_and_skewed_clock():
    raw = [{"kind": "tap", "surface": "s" * 500, "element": "e", "ts": NOW + 30 * 86400}]
    events, _ = usage.clean_events(raw, "ios", now=NOW)
    assert len(events[0]["surface"]) == 80
    assert events[0]["ts"] == NOW          # a far-off client clock yields server time
    big = [{"kind": "view", "surface": "a"}] * (usage.MAX_BATCH + 7)
    events, dropped = usage.clean_events(big, "web", now=NOW)
    assert len(events) == usage.MAX_BATCH and dropped == 7


def _row(kind, element, n=0, n_before=0, surface="kanban", actors=1):
    return {"client": "web", "surface": surface, "element": element, "kind": kind,
            "n": n, "actors": actors, "n_before": n_before, "last_ts": NOW}


def test_report_hot_dead_cold_screens():
    rows = [
        _row("seen", "move-to", n=100), _row("tap", "move-to", n=40),
        _row("seen", "export", n=50),                       # seen, never tapped → dead
        _row("seen", "rare", n=3),                          # barely shown → not dead
        _row("seen", "old", n=30), _row("tap", "old", n=0, n_before=12),  # went cold
        _row("view", "", n=9, surface="inbox"),
        _row("view", "", n=0, surface="gone"),              # no opens in window → omitted
    ]
    r = usage.report(rows, [{"detail": "too many buttons"}], 30)
    assert [c["element"] for c in r["hot"]] == ["move-to"]
    assert r["hot"][0]["seen"] == 100 and r["hot"][0]["taps"] == 40
    assert [c["element"] for c in r["dead"]] == ["export"]
    assert [c["element"] for c in r["cold"]] == ["old"]
    assert r["screens"] == [{"client": "web", "surface": "inbox", "opens": 9, "people": 1}]
    assert r["feedback"] == [{"detail": "too many buttons"}]
    assert r["totals"] == {"controls": 4, "taps": 40}
    assert "last_ts" not in r["hot"][0]


def test_report_empty():
    r = usage.report([], [], 7)
    assert r["hot"] == r["dead"] == r["cold"] == r["screens"] == [] and r["days"] == 7
