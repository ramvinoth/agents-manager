"""The EXACT APNs payload for a permission push, built from the real server
code path (engine._push_label / engine._perm_push_body -> push.build_payload),
for a session with and without a title, for a Bash prompt. No real push is
sent — build_payload is pure.

Reproduces the reported defects (cards #31/#42, 2026-09-19): a push titled
'Chat s2'/'Chat s4' — a raw-id label the owner cannot map to a session — and
a body 'Approve Bash?' with no command. Two code causes:
  1. _push_label's last fallback was a bare 'Chat <id>' with no project
     fallback, and
  2. _perm_push_body assumed a dict input (a JSON-string input crashed it and
     silently killed the push) and, for non-Bash tools, dumped the WHOLE input
     JSON (a lock-screen notification showing the tool's payload — possible
     secrets — instead of an identity).
"""
import json
from pathlib import Path

import pytest

from viewer import db, engine, push

SID = "65cf166a-e3e9-4b72-8a9e-15f8d8d2dd49"


@pytest.fixture
def label_env(monkeypatch):
    """Isolate the label fallback chain: no transcript title, a controllable
    goal, a controllable transcript location."""
    state = {"goal": "", "transcript": None}
    monkeypatch.setattr(engine, "_session_title", lambda sid: "")
    monkeypatch.setattr(db, "session_meta_get",
                        lambda sid: {"goal": state["goal"]} if state["goal"] else {})
    monkeypatch.setattr(engine, "transcript_path", lambda sid: state["transcript"])
    return state


def test_title_preferred(label_env, monkeypatch):
    monkeypatch.setattr(engine, "_session_title", lambda sid: "Fix the login bug")
    assert engine._push_label(SID, "/any/cwd") == "Fix the login bug"


def test_goal_second(label_env):
    label_env["goal"] = "Finish the migration to Postgres, for real this time"
    assert engine._push_label(SID, "") == "Finish the migration to Postgres, for real this time"[:60]


def test_cwd_third(label_env):
    assert engine._push_label(SID, "/Users/rponnarasu/srv/tim/agents/") == "agents"


def test_project_beats_raw_id(label_env):
    """The reported 'Chat s2' class: nothing but a transcript. The label must
    resolve to the project name, not a raw id."""
    label_env["transcript"] = (
        Path("/x/-Users-rponnarasu-srv-tim-agents") / f"{SID}.jsonl"
    )
    assert engine._push_label(SID, "") == "agents"


def test_raw_id_only_when_genuinely_unknown(label_env):
    # Truly nothing: no title, no goal, no cwd, no transcript.
    assert engine._push_label("s2", "") == "Chat s2"


def test_bash_body_shows_the_command():
    body = engine._perm_push_body("Bash", {"command": "ls -la /tmp"}, "local")
    assert body == "Approve Bash? — ls -la /tmp"


def test_bash_json_string_input_no_longer_kills_the_push():
    # The CLI sends some tool inputs as a JSON STRING; the old code called
    # .get() on it and the exception swallowed the whole notification.
    body = engine._perm_push_body("Bash", '{"command": "ls"}', "local")
    assert body == "Approve Bash? — ls"


def test_bash_command_with_secret_is_redacted():
    body = engine._perm_push_body(
        "Bash",
        {"command": "curl -H 'Authorization: Bearer sk-abc123' https://api.example.com"},
        "local",
    )
    assert "sk-abc123" not in body
    assert "Bearer ***" in body


def test_non_bash_tool_previews_identity_not_payload():
    body = engine._perm_push_body(
        "Edit",
        {"file_path": "/srv/tim/agents/viewer/push.py",
         "content": "internal secret draft text"},
        "local",
    )
    assert "file_path=/srv/tim/agents/viewer/push.py" in body
    assert "internal secret draft text" not in body


def test_long_preview_is_capped():
    body = engine._perm_push_body("Bash", {"command": "echo " + "x" * 200}, "local")
    assert len(body) <= len("Approve Bash? — ") + 79 + 1
    assert body.endswith("…")


def test_remote_host_is_named():
    body = engine._perm_push_body("Bash", {"command": "ls"}, "suha-ai")
    assert body == "Approve Bash? — ls (on suha-ai)"


def test_exact_apns_payload_shape(label_env):
    """The wire shape: title + body under aps.alert, the deep-link data dict
    under the root 'body' key (expo-notifications reads userInfo[@"body"]),
    body capped at 300 chars. (label_env isolates the title chain — without it
    the real transcript of this session's own id would win.)"""
    data = {"session": SID, "host": "local", "approval": "pid-1"}
    payload = push.build_payload(engine._push_label(SID, "/x/agents"),
                                 engine._perm_push_body("Bash", {"command": "ls"}, "local"),
                                 data)
    parsed = json.loads(json.dumps(payload))
    assert parsed["aps"]["alert"]["title"] == "agents"
    assert parsed["aps"]["alert"]["body"] == "Approve Bash? — ls"
    assert parsed["aps"]["sound"] == "default"
    assert parsed["body"] == data
