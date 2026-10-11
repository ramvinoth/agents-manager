"""Per-chat plugins and extras (viewer.chatplugins + config.session_plugin_dirs).

A chat's Harman plugins live in session_meta.agentPlugins (its template's
agentPlugin when it never chose); its own skills/MCP live in a generated plugin
folder. Both reach a local Claude run as repeated --plugin-dir. Pure: the meta
row is an in-memory dict and the chat-plugin root a tmp dir."""
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from viewer import chatplugins, config
from viewer.config import session_plugin_dirs, session_plugins

SID = "0a1b2c3d-1111-2222-3333-444455556666"


class TestChatPlugins(unittest.TestCase):
    def setUp(self):
        self.store = {}
        patch("viewer.db.session_meta_get", side_effect=lambda sid: dict(self.store.get(sid, {}))).start()
        patch("viewer.db.session_meta_patch",
              side_effect=lambda sid, f: self.store.setdefault(sid, {}).update(f)).start()
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        patch.object(config, "CHAT_PLUGINS_DIR", Path(tmp.name) / "chats").start()
        patch.object(config, "TEMPLATE_PLUGINS_DIR", Path(tmp.name) / "templates").start()
        self.templates = {7: {"id": 7, "plugin": "privacy-guard", "plugins": None}}
        patch("viewer.db.agent_template_get", side_effect=lambda tid: self.templates.get(tid)).start()
        patch("viewer.db.agent_template_set_plugins",
              side_effect=lambda tid, names: self.templates[tid].update(plugins=list(names))).start()
        self.addCleanup(patch.stopall)

    def test_template_plugin_is_the_default_and_unknowns_drop(self):
        self.assertEqual(session_plugins({"agentPlugin": "privacy-guard"}), ["privacy-guard"])
        self.assertEqual(session_plugins({}), [])
        self.assertEqual(session_plugins({"agentPlugins": ["../etc", "nope", "cyber-security"]}), ["cyber-security"])
        # An explicit empty choice beats the template: the owner removed it.
        self.assertEqual(session_plugins({"agentPlugin": "privacy-guard", "agentPlugins": []}), [])

    def test_add_remove_plugin_and_included_flag(self):
        self.store[SID] = {"agentPlugin": "privacy-guard"}
        self.assertEqual(chatplugins.set_plugin(SID, "cyber-security", True), ["privacy-guard", "cyber-security"])
        self.assertEqual(chatplugins.set_plugin(SID, "cyber-security", True), ["privacy-guard", "cyber-security"])
        self.assertEqual(chatplugins.set_plugin(SID, "privacy-guard", False), ["cyber-security"])
        with self.assertRaises(chatplugins.ChatPluginError):
            chatplugins.set_plugin(SID, "not-a-plugin", True)
        caps = chatplugins.merge_into({"skills": [], "mcp": [], "plugins": []}, SID)
        rows = {p["name"]: p for p in caps["plugins"]}
        self.assertTrue(rows["privacy-guard"]["included"])
        self.assertFalse(rows["privacy-guard"]["active"])
        self.assertTrue(rows["cyber-security"]["active"])
        self.assertTrue(any(s["source"] == "plugin:cyber-security" for s in caps["skills"]))
        self.assertFalse(any(s["source"] == "plugin:privacy-guard" for s in caps["skills"]))

    def test_chat_extras_are_a_valid_plugin_on_the_run(self):
        self.assertEqual(session_plugin_dirs(SID, {}), [])
        chatplugins.save_skill(SID, "my-skill", "---\ndescription: d\n---\n")
        chatplugins.save_mcp(SID, "srv", {"command": "echo"})
        root = config.chat_plugin_dir(SID)
        self.assertEqual(json.loads((root / ".claude-plugin" / "plugin.json").read_text())["name"], "chat")
        dirs = session_plugin_dirs(SID, {"agentPlugin": "privacy-guard"})
        self.assertEqual([d.name for d in dirs], ["privacy-guard", SID])
        caps = chatplugins.merge_into({}, SID)
        self.assertIn({"name": "my-skill", "source": "chat", "editable": True},
                      [{k: s[k] for k in ("name", "source", "editable")} for s in caps["skills"]])
        self.assertEqual([(m["name"], m["scope"], m["editable"]) for m in caps["mcp"]], [("srv", "chat", True)])
        chatplugins.delete_mcp(SID, "srv")
        with self.assertRaises(chatplugins.ChatPluginError):
            chatplugins.delete_mcp(SID, "srv")

    def test_bad_ids_and_names_never_touch_disk(self):
        self.assertIsNone(config.chat_plugin_dir("../x", create=True))
        with self.assertRaises(chatplugins.ChatPluginError):
            chatplugins.save_skill(SID, "../evil", "")

    def test_fork_copies_and_purge_removes(self):
        chatplugins.save_skill(SID, "s1", "x")
        child = "99999999-1111-2222-3333-444455556666"
        chatplugins.fork(SID, child)
        self.assertTrue((config.chat_plugin_dir(child) / "skills" / "s1" / "SKILL.md").exists())
        chatplugins.purge(SID)
        self.assertIsNone(config.chat_plugin_dir(SID))
        chatplugins.fork(SID, "88888888-1111-2222-3333-444455556666")   # no extras: no folder made
        self.assertIsNone(config.chat_plugin_dir("88888888-1111-2222-3333-444455556666"))

    def test_an_agent_keeps_a_chats_setup_for_its_next_chats(self):
        # A chat from agent 7 starts with its seeded plugin and no extras.
        self.store[SID] = chatplugins.start_from_template(self.templates[7], SID)
        self.assertEqual(session_plugins(self.store[SID]), ["privacy-guard"])
        self.assertIsNone(config.chat_plugin_dir(SID))
        # The owner customises it, then keeps that on the agent.
        chatplugins.set_plugin(SID, "cyber-security", True)
        chatplugins.save_skill(SID, "s1", "x")
        chatplugins.save_mcp(SID, "srv", {"command": "echo"})
        self.assertEqual(chatplugins.save_to_template(SID)["plugins"], ["privacy-guard", "cyber-security"])
        # The next chat from agent 7 starts with all of it, marked as the agent's.
        nxt = "77777777-1111-2222-3333-444455556666"
        self.store[nxt] = chatplugins.start_from_template(self.templates[7], nxt)
        self.assertEqual(session_plugins(self.store[nxt]), ["privacy-guard", "cyber-security"])
        caps = chatplugins.merge_into({}, nxt)
        self.assertTrue(all(p["included"] for p in caps["plugins"] if p["active"]))
        self.assertTrue(any(s["name"] == "s1" and s["source"] == "chat" for s in caps["skills"]))
        self.assertEqual([m["name"] for m in caps["mcp"] if m["scope"] == "chat"], ["srv"])
        # A re-save is an exact snapshot: a skill removed in the chat leaves the agent.
        import shutil
        shutil.rmtree(config.chat_plugin_dir(SID) / "skills" / "s1")
        chatplugins.save_to_template(SID)
        self.assertFalse((config.template_plugin_dir(7) / "skills" / "s1").exists())
        chatplugins.purge_template(7)
        self.assertIsNone(config.template_plugin_dir(7))

    def test_save_to_agent_needs_a_chat_started_from_one(self):
        self.store[SID] = {}
        with self.assertRaises(chatplugins.ChatPluginError):
            chatplugins.save_to_template(SID)


if __name__ == "__main__":
    unittest.main()
