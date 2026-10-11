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
        patch.object(config, "CHAT_PLUGINS_DIR", Path(tmp.name)).start()
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


if __name__ == "__main__":
    unittest.main()
