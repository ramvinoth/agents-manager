"""orchestrator.usage: batch validation and the hot/dead/cold digest (pure, no DB)."""
from orchestrator import usage

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
    assert r["totals"] == {"controls": 4, "uses": 40, "taps": 40, "long_presses": 0, "swipes": 0}
    assert "last_ts" not in r["hot"][0]


def _ios(kind, element, n=0, n_before=0, surface="Thread"):
    return dict(_row(kind, element, n, n_before, surface), client="ios")


def test_clean_accepts_phone_gestures_with_a_name():
    raw = [{"kind": "long_press", "surface": "Thread", "element": "chat-message"},
           {"kind": "swipe", "surface": "Thread", "element": "swipe-board"},
           {"kind": "swipe", "surface": "Thread", "element": ""}]          # a gesture needs a name
    events, dropped = usage.clean_events(raw, "ios", now=NOW)
    assert [e["kind"] for e in events] == ["long_press", "swipe"] and dropped == 1


def test_report_counts_every_gesture_as_a_use_and_flags_phone_dead_controls():
    rows = [
        _ios("seen", "chat-message", n=60), _ios("long_press", "chat-message", n=7),
        _ios("seen", "swipe-board", n=25), _ios("swipe", "swipe-board", n=3),
        _ios("tap", "swipe-board", n=1),
        _ios("seen", "attach", n=40),                       # phone control, never used → dead
        _ios("seen", "menu", n=30), _ios("swipe", "menu", n=0, n_before=2),   # gesture went cold
        _row("seen", "attach", n=40), _row("tap", "attach", n=5),            # same name on web: apart
    ]
    r = usage.report(rows, [], 30)
    by = {(c["client"], c["element"]): c for c in r["hot"]}
    assert by[("ios", "chat-message")]["long_presses"] == 7 and by[("ios", "chat-message")]["uses"] == 7
    assert by[("ios", "swipe-board")]["uses"] == 4 and by[("ios", "swipe-board")]["swipes"] == 3
    assert [(c["client"], c["element"]) for c in r["dead"]] == [("ios", "attach")]
    assert [(c["client"], c["element"]) for c in r["cold"]] == [("ios", "menu")]
    assert r["totals"] == {"controls": 5, "uses": 16, "taps": 6, "long_presses": 7, "swipes": 3}


def test_report_empty():
    r = usage.report([], [], 7)
    assert r["hot"] == r["dead"] == r["cold"] == r["screens"] == [] and r["days"] == 7


def test_report_leaves_controls_off_screen_for_days_out_of_dead_and_cold():
    day = 86400
    rows = [
        dict(_row("seen", "chips", n=400), last_ts=NOW - 4 * day),      # a build dropped it
        dict(_row("seen", "legacy", n=30), last_ts=NOW - 4 * day),
        _row("tap", "legacy", n=0, n_before=4),                          # would read as cold
        _row("seen", "search", n=400),                                    # on screen, never used
        # the side menu, unopened overnight while its screen stayed in use: still there
        dict(_row("seen", "menu-agents", n=25, surface="chats"), last_ts=NOW - 13 * 3600),
        _row("seen", "menu-button", n=900, surface="chats"),
    ]
    r = usage.report(rows, [], 30, now=NOW)
    assert [c["element"] for c in r["dead"]] == ["menu-button", "search", "menu-agents"]
    assert r["cold"] == []
    assert r["stale"] == [{"client": "web", "surface": "kanban", "element": "chips"},
                          {"client": "web", "surface": "kanban", "element": "legacy"}]
    assert r["totals"]["controls"] == 5
