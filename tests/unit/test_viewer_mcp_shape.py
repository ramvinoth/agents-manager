"""Progressive disclosure in the agent's MCP adapter (viewer/viewer_mcp.py)."""
import json

from viewer.viewer_mcp import _RESULT_CAP, shape_result


def test_full_returns_untouched():
    big = {"cards": [{"id": i, "body": "x" * 500} for i in range(100)]}
    assert shape_result("card_list", big, full=True) is big


def test_card_list_pages_and_keeps_the_servers_preview():
    # The server's ledger view already cuts bodies; a second cut here
    # reported the preview's length as the body's.
    rows = {"cards": [{"id": i, "body": "x" * 280 + "…"} for i in range(75)], "done_hidden": 2}
    out = shape_result("card_list", rows)
    assert out["total"] == 75 and out["shown"] == 10 and out["more"] == "offset=10"
    assert out["done_hidden"] == 2
    assert out["cards"][0]["body"] == "x" * 280 + "…"
    last = shape_result("card_list", rows, offset=60, limit=30)
    assert [c["id"] for c in last["cards"]] == list(range(60, 75)) and "more" not in last


def test_loop_list_bare_list_becomes_items():
    out = shape_result("loop_list", [{"id": str(i), "prompt": "p" * 900} for i in range(40)], limit=10)
    assert out["total"] == 40 and len(out["items"]) == 10
    assert out["items"][0]["prompt"].startswith("p" * 160) and "900 chars" in out["items"][0]["prompt"]


def test_card_keeps_newest_comments():
    card = {"card": {"id": 1}, "comments": [{"id": i, "body": "c"} for i in range(12)]}
    out = shape_result("card", card)
    assert [c["id"] for c in out["comments"]] == [7, 8, 9, 10, 11] and out["comments_total"] == 12
    assert "card_id=1 " in out["comments_hint"]


def test_note_preview_names_the_real_id():
    out = shape_result("note_list", {"notes": [{"id": 112, "body": "n" * 900}]})
    assert "full text: note id=112]" in out["notes"][0]["body"]


def test_inbox_bodies_cut_queue_kept():
    res = {"messages": [{"id": 1, "body": "m" * 2000}], "owner_queue": {"cap": 3}}
    out = shape_result("inbox_list", res)
    assert len(out["messages"][0]["body"]) < 400 and out["owner_queue"] == {"cap": 3}


def test_global_cap_and_errors_pass_through():
    huge = {"x": "y" * (_RESULT_CAP * 3)}
    out = shape_result("docs_read", huge)
    assert "_truncated" in out and len(json.dumps(out)) < _RESULT_CAP + 500
    err = {"error": "nope"}
    assert shape_result("card_list", err) is err


def test_short_results_unchanged():
    small = {"cards": [{"id": 1, "body": "hi"}]}
    assert shape_result("card_list", small)["cards"] == small["cards"]


def test_rows_drop_empty_fields_and_twinned_epochs():
    rows = {"cards": [{"id": 1, "ask_since": None, "deps": [], "created_at": 1.79e9,
                       "created_at_local": "2026-11-09 9:00 AM PST"}]}
    assert shape_result("card_list", rows)["cards"] == [{"id": 1, "created_at_local": "2026-11-09 9:00 AM PST"}]
