"""find_tool_call: the server-side backward seek that anchors a decision in a
chat too long for the client to page through."""
import json

from orchestrator.config import find_tool_call


def _write(tmp_path, recs):
    p = tmp_path / "s.jsonl"
    p.write_text("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in recs))
    return p


def _call(name, inp, id_="toolu_1", ts="2026-10-01T00:00:00Z"):
    return {"type": "assistant", "timestamp": ts,
            "message": {"content": [{"type": "tool_use", "id": id_, "name": name, "input": inp}]}}


def test_newest_card_call_wins(tmp_path):
    p = _write(tmp_path, [
        _call("mcp__viewer__card_comment", {"card_id": 7, "body": "old"}, ts="a"),
        _call("mcp__viewer__card_comment", {"card_id": 7, "body": "new"}, ts="b"),
        _call("mcp__viewer__card_comment", {"card_id": 70, "body": "other"}),
    ])
    hit = find_tool_call(p, "card_id", 7)
    assert hit["input"]["body"] == "new" and hit["timestamp"] == "b"


def test_offset_is_the_line_start(tmp_path):
    p = _write(tmp_path, [{"type": "user", "message": {"content": "hi"}},
                          _call("AskUserQuestion", {"questions": []}, id_="toolu_q")])
    hit = find_tool_call(p, "id", "toolu_q")
    with open(p, "rb") as f:
        f.seek(hit["offset"])
        assert json.loads(f.readline())["type"] == "assistant"


def test_only_assistant_records_count(tmp_path):
    # api-request blobs and tool results quote the same strings; they are not the call.
    p = _write(tmp_path, [{"type": "user", "message": {"content": '{"card_id":5}'}},
                          {"type": "assistant", "message": {"content": [{"type": "text", "text": '"card_id":5'}]}}])
    assert find_tool_call(p, "card_id", 5) is None


def test_card_update_is_not_a_card_reference(tmp_path):
    p = _write(tmp_path, [_call("mcp__viewer__card_update", {"card_id": 3})])
    assert find_tool_call(p, "card_id", 3) is None


def test_finds_across_chunks_and_long_lines(tmp_path):
    filler = [{"type": "user", "message": {"content": "x" * 300}} for _ in range(50)]
    p = _write(tmp_path, [_call("ExitPlanMode", {"plan": "P"}, id_="toolu_p")] + filler)
    assert find_tool_call(p, "id", "toolu_p", chunk=64)["input"] == {"plan": "P"}
    assert find_tool_call(p, "id", "toolu_missing", chunk=64) is None


def test_empty_file(tmp_path):
    p = tmp_path / "e.jsonl"
    p.write_text("")
    assert find_tool_call(p, "id", "x") is None


def _result(id_, text):
    return {"type": "user", "message": {"content": [
        {"tool_use_id": id_, "type": "tool_result", "content": [{"type": "text", "text": text}]}]}}


def test_a_created_card_is_found_by_its_create_call(tmp_path):
    # A card never moved or commented on is anchored by the card_create whose result named it.
    p = _write(tmp_path, [
        _call("mcp__viewer__card_create", {"title": "Ship it?"}, id_="toolu_c"),
        _result("toolu_c", json.dumps({"id": 246, "title": "Ship it?"})),
        _call("mcp__viewer__note_create", {"title": "n"}, id_="toolu_n"),
        _result("toolu_n", json.dumps({"id": 24, "title": "n"})),
    ])
    hit = find_tool_call(p, "card_id", 246)
    assert hit["name"] == "mcp__viewer__card_create" and hit["input"]["title"] == "Ship it?"
    with open(p, "rb") as f:
        f.seek(hit["offset"])
        assert json.loads(f.readline())["type"] == "assistant"
    # Another tool's result with the same leading id is not a card.
    assert find_tool_call(p, "card_id", 24) is None
