"""The permission push names the asking session and shows what it asks.

A push titled 'Chat 1a2b3c4d' with the body 'Approve Bash?' gives the owner
nothing to judge from. The label falls back to the transcript's project before
the raw id, and the body carries a capped, secret-redacted preview of the
command (or the tool's identity field), plus the host when the run is remote.
"""
import json

import pytest

from viewer import engine

SID = "00000000-aaaa-bbbb-cccc-000000000001"


@pytest.fixture
def label_env(monkeypatch, tmp_path):
    monkeypatch.setattr(engine, "_session_title", lambda sid: "")
    monkeypatch.setattr(engine, "SESSION_META", {})
    monkeypatch.setattr(engine, "CLAUDE_DIR", tmp_path)
    return tmp_path


def test_title_preferred(label_env, monkeypatch):
    monkeypatch.setattr(engine, "_session_title", lambda sid: "Fix the login bug")
    assert engine._push_label(SID, "/any/cwd") == "Fix the login bug"


def test_goal_then_cwd(label_env, monkeypatch):
    monkeypatch.setattr(engine, "SESSION_META", {SID: {"goal": "Ship the release"}})
    assert engine._push_label(SID, "/home/user/proj") == "Ship the release"
    monkeypatch.setattr(engine, "SESSION_META", {})
    assert engine._push_label(SID, "/home/user/proj") == "proj"


def test_project_before_raw_id(label_env):
    d = label_env / "-home-user-webapp"
    d.mkdir()
    (d / f"{SID}.jsonl").write_text("")
    assert engine._push_label(SID, "") == "webapp"


def test_raw_id_last_resort(label_env):
    assert engine._push_label(SID, "") == "Chat 00000000"


def test_bash_body_shows_command():
    body = engine._perm_push_body("Bash", {"command": "git push origin main"}, "local")
    assert body == "Approve Bash? — git push origin main"


def test_json_string_input_and_remote_host():
    body = engine._perm_push_body("Bash", json.dumps({"command": "ls -la"}), "box1")
    assert body == "Approve Bash? — ls -la (on box1)"


def test_secrets_redacted():
    body = engine._perm_push_body(
        "Bash", {"command": "curl -H 'Authorization: Bearer abc123xyz' https://x"}, "local")
    assert "abc123xyz" not in body and "***" in body


def test_non_bash_shows_identity_not_payload():
    body = engine._perm_push_body(
        "Write", {"file_path": "/tmp/a.txt", "content": "TOP SECRET"}, "local")
    assert body == "Approve Write? — file_path=/tmp/a.txt"


def test_preview_capped():
    body = engine._perm_push_body("Bash", {"command": "echo " + "x" * 300}, "local")
    assert body.endswith("…") and len(body) < 120


def test_garbage_input_falls_back():
    assert engine._perm_push_body("Bash", "not json", None) == "Approve Bash?"
