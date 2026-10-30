"""The per-chat plugin routes (viewer/routes/capabilities.py) end to end over
the mixin: POST /api/chat/plugin, chat-scoped skill and MCP saves, and the
capabilities read that merges a chat's plugins.

The gates are the point: only a human writes (a chat's MCP server is code that
runs on this machine), only a real local session gets a folder, and a path that
is not one never creates anything. Session meta is an in-memory dict and the
plugin roots are a tmp dir — no Postgres, no real ~/.claude.
"""
import json
from pathlib import Path

import pytest

from viewer import config
from viewer.routes import capabilities as cap_routes
from viewer.routes.capabilities import CapabilitiesMixin
from viewer.server import SessionViewerHandler

SID = "0a1b2c3d-1111-2222-3333-444455556666"
REL = f"projects/-Users-x-proj/{SID}.jsonl"
HUMAN = {"user": {"id": 1}}
AGENT = {"user": None, "session": "s"}


class _Handler(CapabilitiesMixin):
    sid_from_path = staticmethod(SessionViewerHandler.sid_from_path)

    def __init__(self, body, sessions=(REL,)):
        self.sent = None
        self._body = body
        self._sessions = set(sessions)

    def send_json(self, data, status=200):
        self.sent = (data, status)

    def read_body(self):
        return self._body

    def resolve_session_quiet(self, rel):
        return Path("/fake") / rel if rel in self._sessions else None


class _Req:
    def __init__(self, principal=HUMAN):
        self.principal = principal
        self.query = {}


@pytest.fixture
def store(tmp_path, monkeypatch):
    meta = {}
    monkeypatch.setattr("viewer.db.session_meta_get", lambda sid: dict(meta.get(sid, {})))
    monkeypatch.setattr("viewer.db.session_meta_patch", lambda sid, f: meta.setdefault(sid, {}).update(f))
    monkeypatch.setattr("viewer.db.agent_template_get", lambda tid: None)
    monkeypatch.setattr(config, "CHAT_PLUGINS_DIR", tmp_path / "chats")
    monkeypatch.setattr(config, "TEMPLATE_PLUGINS_DIR", tmp_path / "templates")
    return meta


def test_human_adds_and_removes_a_plugin(store):
    h = _Handler({"session": REL, "name": "cyber-security", "on": True})
    h._p_chat_plugin(_Req())
    assert h.sent == ({"plugins": ["cyber-security"]}, 200)
    assert store[SID]["agentPlugins"] == ["cyber-security"]
    h = _Handler({"session": REL, "name": "cyber-security", "on": False})
    h._p_chat_plugin(_Req())
    assert h.sent == ({"plugins": []}, 200)


def test_unknown_plugin_is_404_and_changes_nothing(store):
    h = _Handler({"session": REL, "name": "../../etc", "on": True})
    h._p_chat_plugin(_Req())
    assert h.sent[1] == 404
    assert SID not in store


def test_an_agent_principal_cannot_write(store):
    h = _Handler({"session": REL, "name": "cyber-security", "on": True})
    h._p_chat_plugin(_Req(AGENT))
    assert h.sent[1] == 403 and SID not in store
    h = _Handler({"session": REL, "name": "evil", "scope": "chat", "config": {"command": "sh"}})
    h.handle_mcp_save(_Req(AGENT))
    assert h.sent[1] == 403
    assert not config.CHAT_PLUGINS_DIR.exists()


@pytest.mark.parametrize("session", [
    "../../../../etc/passwd",
    f"projects/-x/../../{SID}.jsonl",   # traversal around a real-looking id
    "projects/-x/not-a-session.txt",
    "",
])
def test_a_path_that_is_not_a_local_session_never_makes_a_folder(store, session):
    # Only REL resolves as a session; everything else must 404 before any write.
    h = _Handler({"session": session, "name": "s1", "scope": "chat", "content": "x"})
    h.handle_skill_save(_Req())
    assert h.sent[1] == 404
    assert not config.CHAT_PLUGINS_DIR.exists()


def test_chat_scoped_skill_and_mcp_land_in_the_chats_plugin(store, monkeypatch):
    monkeypatch.setattr(cap_routes, "MCP_CDP_CACHE", {})
    h = _Handler({"session": REL, "name": "my-skill", "scope": "chat", "content": "---\ndescription: d\n---\n"})
    h.handle_skill_save(_Req())
    assert h.sent[1] == 200
    root = config.CHAT_PLUGINS_DIR / SID
    assert (root / "skills" / "my-skill" / "SKILL.md").is_file()
    assert json.loads((root / ".claude-plugin" / "plugin.json").read_text())["name"] == config.CHAT_PLUGIN_NAME

    h = _Handler({"session": REL, "name": "srv", "scope": "chat", "config": {"command": "echo"}})
    h.handle_mcp_save(_Req())
    assert h.sent == ({"saved": True}, 200)
    assert json.loads((root / ".mcp.json").read_text()) == {"mcpServers": {"srv": {"command": "echo"}}}

    h = _Handler({"session": REL, "name": "srv", "scope": "chat"})
    h.handle_mcp_save(_Req(), delete=True)
    assert h.sent[1] == 200
    h.handle_mcp_save(_Req(), delete=True)   # already gone
    assert h.sent[1] == 404


class _FakeHost:
    def extract_cwd(self, rel):
        return ""

    def capabilities(self, cwd):
        return {"skills": [], "mcp": [], "plugins": [
            {"name": "machine-one", "description": "", "source": "machine", "included": False, "active": True}]}


def test_capabilities_merge_a_local_claude_chats_plugins_only(store, monkeypatch):
    monkeypatch.setattr(cap_routes, "get_host", lambda host: _FakeHost())
    store[SID] = {"agentPlugin": "privacy-guard"}
    caps, status = _Handler({}).compute_capabilities("local", "claude", REL)
    assert status is None
    rows = {p["name"]: p for p in caps["plugins"]}
    assert rows["privacy-guard"]["included"] and rows["privacy-guard"]["active"]
    assert rows["machine-one"]["source"] == "machine"   # machine plugins stay, read-only
    assert any(s["source"] == "plugin:privacy-guard" for s in caps["skills"])
    # Another machine: the chat's plugins don't ride its runs, so none are merged.
    caps, _ = _Handler({}).compute_capabilities("box1", "claude", REL)
    assert [p["source"] for p in caps["plugins"]] == ["machine"]
