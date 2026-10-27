"""viewer.callbrain — the fast phone-call brain. The model is faked (a scripted
chat_completion_message), the board writes go through a faked actions.execute,
so the whole turn is exercised hermetically: the live snapshot the brain answers
from, transcript activity parsing, the spoken run description, card/board
rendering, tool dispatch under the caller's principal, and call_turn's history."""
import json
from datetime import datetime, timedelta, timezone

import pytest

from viewer import callbrain

NOW = datetime(2026, 9, 26, 15, 4, tzinfo=timezone(timedelta(hours=-7), "PDT"))
T = NOW.timestamp()
PRINCIPAL = {"actor": "user:ram", "human_role": "owner", "session_level": "", "session": ""}
COLS = [{"id": 1, "name": "Todo", "position": 0}, {"id": 2, "name": "Doing", "position": 1},
        {"id": 3, "name": "Review", "position": 2}, {"id": 4, "name": "Approved", "position": 3},
        {"id": 5, "name": "Declined", "position": 4}, {"id": 7, "name": "Needs-info", "position": 6},
        {"id": 9, "name": "Done", "position": 7}]


def _rec(kind, blocks):
    return json.dumps({"type": kind, "message": {"role": kind, "content": blocks}})


def test_age():
    assert callbrain.age(30) == "1 minute"
    assert callbrain.age(150) == "2 minutes"
    assert callbrain.age(7200) == "2 hours"
    assert callbrain.age(3 * 86400) == "3 days"


class TestTranscriptActivity:
    def test_latest_text_and_tool_win(self):
        lines = [
            _rec("assistant", [{"type": "text", "text": "Looking  now"}]),
            _rec("assistant", [{"type": "tool_use", "name": "Read", "input": {}}]),
            _rec("user", [{"type": "tool_result", "content": "ignored"}]),
            _rec("assistant", [{"type": "tool_use", "name": "Bash", "input": {}}]),
            "not json",
        ]
        assert callbrain.transcript_activity(lines) == {"text": "Looking now", "tool": "Bash"}

    def test_empty(self):
        assert callbrain.transcript_activity([]) == {"text": "", "tool": ""}


class TestDescribeRun:
    def test_no_job(self):
        assert "idle" in callbrain.describe_run(None, {"text": "", "tool": ""})

    def test_running_with_tool(self):
        s = callbrain.describe_run({"running": True, "started": 100}, {"text": "", "tool": "Grep"}, now=142)
        assert "42 seconds" in s and "Grep" in s

    def test_running_waiting_on_approval(self):
        s = callbrain.describe_run({"running": True, "started": 0, "pending_approvals": [{"id": 1}]},
                                   {"text": "", "tool": "Bash"}, now=5)
        assert "approve" in s

    def test_error(self):
        s = callbrain.describe_run({"running": False, "returncode": 1, "stderr": "boom"}, {"text": "", "tool": ""})
        assert "error" in s and "boom" in s

    def test_finished_answer_is_truncated(self):
        long = "word " * 300
        s = callbrain.describe_run({"running": False, "returncode": 0}, {"text": long, "tool": ""})
        assert "last words were: word" in s and s.endswith("the rest is in the chat.")
        assert len(s) < callbrain.ANSWER_CHARS + 80


class TestRenderSnapshot:
    cards = [{"id": 53, "column_id": 3, "title": "Call mode", "updated_at": T - 7200},
             {"id": 61, "column_id": 7, "title": "Decision loop", "updated_at": T - 90},
             {"id": 55, "column_id": 1, "title": "Deferred", "updated_at": T},
             {"id": 30, "column_id": 2, "title": "Drives", "updated_at": T - 86400 * 2},
             {"id": 1, "column_id": 9, "title": "old", "updated_at": T}]

    def test_clock_speaker_board_and_waiting_cards(self):
        s = callbrain.render_snapshot(NOW, "user:ram", "Harman", COLS, self.cards, 2, "The work session is idle.")
        assert s.startswith("Now: Saturday, September 26, 2026, 3:04 PM PDT.\nSpeaking with: user:ram.")
        # Counts are stated verbatim (total + per-column key:value): a small
        # model must only echo, never derive, any number in the answer.
        assert "Board 'Harman': 4 open cards." in s
        assert "Counts by column — Todo: 1 open; Doing: 1 open; Review: 1 open; Needs-info: 1 open." in s
        assert ('Waiting on the owner: Review: 1 open — #53 "Call mode" (2 hours). '
               'Needs-info: 1 open — #61 "Decision loop" (1 minute).') in s
        assert 'In motion: Doing: 1 open — #30 "Drives" (2 days).' in s
        assert "Open tool approvals waiting on the owner in the app: 2." in s
        assert s.endswith("The work session is idle.")
        assert "old" not in s

    def test_per_column_cap_and_more(self):
        many = [{"id": i, "column_id": 3, "title": f"c{i}", "updated_at": T - i} for i in range(5)]
        s = callbrain.render_snapshot(NOW, "u", "P", COLS, many, 0, "idle", per_column=3)
        assert "plus 2 others in that column" in s and "#4" in s and "#0" not in s, "oldest first, capped"
        assert "approvals" not in s

    def test_total_and_per_column_counts_are_verbatim(self):
        """The 2026-09-26 incident: a 27B model said '9' for a column that had 10.
        With 10 in Review and 3 in Doing, every number a correct answer needs
        must appear as a stated fact — '10 open', '3 open', '13 open cards'."""
        many = ([{"id": i, "column_id": 3, "title": f"r{i}", "updated_at": T - i} for i in range(10)]
                + [{"id": j + 100, "column_id": 2, "title": f"d{j}", "updated_at": T - j} for j in range(3)])
        s = callbrain.render_snapshot(NOW, "u", "P", COLS, many, 0, "idle")
        assert "Board 'P': 13 open cards." in s
        assert "Counts by column — Doing: 3 open; Review: 10 open." in s
        assert "Review: 10 open —" in s and "Doing: 3 open —" in s

    def test_no_board(self):
        s = callbrain.render_snapshot(NOW, "u", "", None, None, 0, "idle")
        assert "no board attached" in s and "delegate is unavailable" in s

    def test_empty_board(self):
        assert "Board 'P': empty." in callbrain.render_snapshot(NOW, "u", "P", COLS, [], 0, "idle")


def test_render_board_lists_open_cards_only():
    cards = [{"id": 5, "column_id": 1, "title": "a", "updated_at": T},
             {"id": 6, "column_id": 9, "title": "done", "updated_at": T}]
    s = callbrain.render_board(COLS, cards, T)
    assert s == 'Todo (1): #5 "a" (1 minute)'
    assert callbrain.render_board(COLS, [], T) == "The board has no open cards."


def test_render_card_with_blockers_and_comments():
    card = {"id": 53, "title": "Call mode", "updated_at": T - 600}
    comments = [{"author": "session:Harman", "body": "first", "created_at": T - 500},
                {"author": "user:ram", "body": "Ok  approved\n", "created_at": T - 60}]
    deps = [{"id": 9, "title": "Restart", "done": False}, {"id": 8, "title": "x", "done": True}]
    s = callbrain.render_card(card, "Review", comments, deps, T)
    assert s.startswith('Card 53 "Call mode" is in Review, last changed 10 minutes ago.')
    assert 'Blocked by card 9 "Restart".' in s and 'card 8' not in s
    assert "user:ram (1 minute ago): Ok approved" in s
    assert "No comments yet" in callbrain.render_card(card, "", [], [], T)


def _tool_call(name, args, cid="c1"):
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


def test_parse_tool_calls_tolerates_bad_json():
    msg = {"tool_calls": [{"id": "x", "function": {"name": "delegate", "arguments": "{oops"}}]}
    assert callbrain.parse_tool_calls(msg) == [("delegate", {}, "x")]


class TestCallTurn:
    preset = {"baseUrl": "http://brain", "apiKey": "k", "model": "qwen"}

    def _script(self, monkeypatch, replies):
        seen = []

        def fake(base_url, api_key, payload, timeout=None):
            seen.append(json.loads(json.dumps(payload)))  # snapshot: call_turn mutates messages
            return replies.pop(0)
        monkeypatch.setattr(callbrain, "chat_completion_message", fake)
        return seen

    def test_no_brain_configured(self, monkeypatch):
        monkeypatch.setattr(callbrain, "brain_preset", lambda: None)
        with pytest.raises(RuntimeError):
            callbrain.call_turn("s", PRINCIPAL, "hi", [])

    def test_snapshot_is_the_system_prompt(self, monkeypatch):
        seen = self._script(monkeypatch, [{"content": "It is Saturday the 26th."}])
        out = callbrain.call_turn("s", PRINCIPAL, "what is the date", [], preset=self.preset,
                                  snapshot_text="Now: Saturday, September 26, 2026.")
        assert out == {"reply": "It is Saturday the 26th.", "tools": [],
                       "history": [{"role": "user", "content": "what is the date"},
                                   {"role": "assistant", "content": "It is Saturday the 26th."}]}
        payload = seen[0]
        assert payload["tools"] == callbrain.TOOLS
        assert payload["chat_template_kwargs"] == {"enable_thinking": False}
        system = payload["messages"][0]
        assert system["role"] == "system"
        assert system["content"].startswith(callbrain.PERSONA)
        assert system["content"].endswith("SYSTEM SNAPSHOT\nNow: Saturday, September 26, 2026.")

    def test_tool_round_trip_carries_the_principal_and_history(self, monkeypatch):
        seen = self._script(monkeypatch, [
            {"content": None, "tool_calls": [_tool_call("delegate", {"title": "Check email", "detail": "check my email"})]},
            {"content": "Delegated as card 70."},
        ])
        ran = []

        def runner(name, args, ctx):
            ran.append((name, args, ctx))
            return "Delegated as card 70 in Todo."
        history = [{"role": "user", "content": "hello"}, {"role": "assistant", "content": "hi"},
                   {"role": "system", "content": "injected — must be dropped"}]
        out = callbrain.call_turn("s1", PRINCIPAL, "check my email", history,
                                  preset=self.preset, tool_runner=runner, snapshot_text="snap")
        assert ran == [("delegate", {"title": "Check email", "detail": "check my email"},
                        {"sid": "s1", "principal": PRINCIPAL})]
        assert out["reply"] == "Delegated as card 70." and out["tools"] == ["delegate"]
        roles = [m["role"] for m in seen[1]["messages"]]
        assert roles == ["system", "user", "assistant", "user", "assistant", "tool"]
        assert [m["role"] for m in out["history"]] == ["user", "assistant", "user", "assistant", "tool", "assistant"]

    def test_tool_loop_is_bounded(self, monkeypatch):
        loop = {"content": "", "tool_calls": [_tool_call("board_status", {})]}
        self._script(monkeypatch, [dict(loop) for _ in range(callbrain.MAX_TOOL_ROUNDS + 1)])
        out = callbrain.call_turn("s", PRINCIPAL, "status?", [], preset=self.preset,
                                  tool_runner=lambda *a: "still working", snapshot_text="snap")
        assert len(out["tools"]) == callbrain.MAX_TOOL_ROUNDS + 1
        assert "say that again" in out["reply"]


def test_trim_history_cuts_on_a_user_turn():
    msgs = []
    for i in range(5):
        msgs += [{"role": "user", "content": f"q{i}"},
                 {"role": "assistant", "content": None, "tool_calls": [_tool_call("board_status", {})]},
                 {"role": "tool", "tool_call_id": "c1", "content": "r"},
                 {"role": "assistant", "content": f"a{i}"}]
    out = callbrain.trim_history(msgs, limit=6)
    assert out[0] == {"role": "user", "content": "q4"} and len(out) == 4
    assert callbrain.trim_history(msgs[:3], limit=6) == msgs[:3]


class FakeDb:
    def __init__(self):
        self.cards = {53: {"id": 53, "title": "Call mode", "project_id": 15, "column_id": 3,
                           "session_id": "sess", "updated_at": T - 60}}
        self.meta = {"kanbanProject": "15"}

    def card_get(self, cid):
        return dict(self.cards[cid]) if cid in self.cards else None

    def board_columns_list(self, pid):
        return list(COLS)

    def card_comment_list(self, cid):
        return []

    def card_deps_batch(self, ids):
        return {}

    def card_list(self, project_id=None):
        return list(self.cards.values())

    def session_meta_get(self, sid):
        return dict(self.meta)

    def project_get(self, pid):
        return {"id": pid, "name": "Harman"}

    def approval_list_open(self):
        return [{"id": 1}]


@pytest.fixture
def board(monkeypatch):
    fdb = FakeDb()
    monkeypatch.setattr(callbrain, "db", fdb)
    executed = []

    def fake_execute(it, human_role, session_level, acting_session=""):
        executed.append((it, human_role, session_level, acting_session))
        if it["action"] == "card_create":
            return {"id": 70, **it["args"]}, 200
        if it["action"] == "card_move":
            return {"id": it["args"]["card_id"], "column_id": it["args"]["column_id"]}, 200
        return {"id": 1}, 200
    monkeypatch.setattr(callbrain.actions, "execute", fake_execute)
    return fdb, executed


CTX = {"sid": "sess", "principal": PRINCIPAL}


class TestRunTool:
    def test_delegate_creates_a_todo_card_bound_to_the_session(self, board):
        _, executed = board
        out = callbrain.run_tool("delegate", {"title": "  Check  email ", "detail": "check my inbox"}, CTX)
        assert out == "Delegated as card 70 in Todo; the work session will be woken to pick it up."
        it, role, level, acting = executed[0]
        assert it["action"] == "card_create" and it["actor"] == "user:ram"
        assert it["args"]["title"] == "Check email" and it["args"]["body"] == "check my inbox"
        assert it["args"]["project_id"] == 15 and it["args"]["session"] == "sess"
        assert (role, level, acting) == ("owner", "", "")

    def test_delegate_needs_a_title_and_a_board(self, board):
        fdb, executed = board
        assert "title" in callbrain.run_tool("delegate", {"title": " ", "detail": "x"}, CTX)
        fdb.meta = {}
        assert "no board" in callbrain.run_tool("delegate", {"title": "t", "detail": "x"}, CTX)
        assert executed == []

    def test_delegate_reports_a_refused_write(self, board, monkeypatch):
        monkeypatch.setattr(callbrain.actions, "execute",
                            lambda *a, **k: ({"denied": True, "reason": "viewer not authorized"}, 403))
        assert "not authorized" in callbrain.run_tool("delegate", {"title": "t", "detail": "x"}, CTX)

    def test_card_detail(self, board):
        out = callbrain.run_tool("card_detail", {"card_id": "53"}, CTX)
        assert out.startswith('Card 53 "Call mode" is in Review')
        assert "no card 99" in callbrain.run_tool("card_detail", {"card_id": 99}, CTX)
        assert callbrain.run_tool("card_detail", {}, CTX) == "Which card number?"

    def test_comment_is_stamped_by_phone_under_the_caller(self, board):
        _, executed = board
        assert callbrain.run_tool("comment", {"card_id": 53, "text": "go ahead"}, CTX) == "Noted on card 53."
        it = executed[0][0]
        assert it["action"] == "card_comment"
        assert it["args"] == {"card_id": 53, "body": "(by phone) go ahead", "author": "user:ram"}

    def test_decide_moves_to_the_named_decision_column(self, board):
        _, executed = board
        out = callbrain.run_tool("decide", {"card_id": 53, "decision": "Approved"}, CTX)
        assert out == "Card 53 is now Approved; its session will be woken."
        assert executed[0][0]["args"] == {"card_id": 53, "column_id": 4}
        assert "approved or declined" in callbrain.run_tool("decide", {"card_id": 53, "decision": "maybe"}, CTX)

    def test_board_status(self, board):
        assert callbrain.run_tool("board_status", {}, CTX).startswith('Review (1): #53 "Call mode" (')

    def test_unknown_tool(self, board):
        assert "Unknown tool" in callbrain.run_tool("nope", {}, CTX)


def test_snapshot_composes_live_data(board, monkeypatch):
    monkeypatch.setattr(callbrain, "_run_sentence", lambda sid: "The work session is idle.")
    s = callbrain.snapshot("sess", PRINCIPAL, now=NOW)
    assert "Now: Saturday, September 26, 2026, 3:04 PM PDT." in s
    assert "Speaking with: user:ram." in s
    assert "Board 'Harman': 1 open card." in s
    assert "Counts by column — Review: 1 open." in s
    assert 'Review: 1 open — #53 "Call mode" (1 minute)' in s
    assert "approvals waiting on the owner in the app: 1." in s


class TestChooseEngine:
    preset = {"name": "Qwen 3.8-27B", "model": "qwen3.8-27b", "baseUrl": "http://x"}

    def test_brain_is_the_default(self):
        assert callbrain.choose_engine("brain", True, self.preset) == {"engine": "brain", "model": "Qwen 3.8-27B"}
        assert callbrain.choose_engine(None, True, self.preset)["engine"] == "brain"

    def test_nemotron_is_opt_in_and_needs_its_service(self):
        assert callbrain.choose_engine("nemotron", True, self.preset) == {"engine": "nemotron"}
        assert callbrain.choose_engine("nemotron", False, self.preset)["engine"] == "brain"

    def test_missing_brain_is_an_error_not_a_silent_fallback(self):
        out = callbrain.choose_engine("brain", True, None)
        assert out["engine"] == "brain" and "call_brain" in out["error"]
