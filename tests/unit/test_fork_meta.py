"""A fork inherits the parent conversation (Claude Code semantics: "inherits the
parent conversation instead of starting fresh", "receives the main conversation's
exact tool pool", "runs on the main conversation's model"). The viewer stores a
session's model/provider/permission-mode/effort/prefs in its session_meta row,
keyed by session id — copying the transcript alone does NOT carry that row, so a
fork silently fell back to defaults. carry_fork_meta is the copy that fixes it.

Pure test: db.session_meta_get/set are stubbed with an in-memory dict, so no
Postgres. Regression for "fork drops provider/model/permission mode".
"""
import unittest
from unittest.mock import patch

from viewer.routes.sessions import SessionsMixin


class TestCarryForkMeta(unittest.TestCase):
    def setUp(self):
        self.store = {}
        self.get = patch("viewer.db.session_meta_get",
                         side_effect=lambda sid: dict(self.store.get(sid, {}))).start()
        self.set = patch("viewer.db.session_meta_set",
                         side_effect=lambda sid, data: self.store.__setitem__(sid, dict(data))).start()
        self.addCleanup(patch.stopall)

    def test_child_inherits_provider_model_mode_effort(self):
        self.store["parent"] = {
            "provider": "copilot", "modelSelection": {"model": "claude-opus-5"},
            "permission_mode": "bypass", "effort": "high", "convMode": "agent",
            "kanbanProject": 15, "title": "Harman",
        }
        SessionsMixin.carry_fork_meta("parent", "child", title="Harman (fork)")
        child = self.store["child"]
        self.assertEqual(child["provider"], "copilot")
        self.assertEqual(child["modelSelection"], {"model": "claude-opus-5"})
        self.assertEqual(child["permission_mode"], "bypass")
        self.assertEqual(child["effort"], "high")
        self.assertEqual(child["convMode"], "agent")
        self.assertEqual(child["kanbanProject"], 15)

    def test_explicit_title_wins_parent_title_does_not_leak(self):
        self.store["parent"] = {"provider": "copilot", "title": "Harman"}
        SessionsMixin.carry_fork_meta("parent", "child", title="My fork")
        self.assertEqual(self.store["child"]["title"], "My fork")

    def test_no_title_means_fork_does_not_copy_parent_title(self):
        # A fork with no explicit title must not become a title-twin of its parent.
        self.store["parent"] = {"provider": "copilot", "title": "Harman"}
        SessionsMixin.carry_fork_meta("parent", "child", title="")
        self.assertNotIn("title", self.store["child"])
        self.assertEqual(self.store["child"]["provider"], "copilot")

    def test_parent_without_meta_writes_nothing(self):
        # No parent row and no title → nothing to carry, no empty row created.
        SessionsMixin.carry_fork_meta("parent", "child", title="")
        self.assertNotIn("child", self.store)

    def test_title_only_when_parent_has_no_meta(self):
        SessionsMixin.carry_fork_meta("parent", "child", title="Fresh")
        self.assertEqual(self.store["child"], {"title": "Fresh"})

    def test_child_is_a_copy_not_an_alias(self):
        # Mutating the child later must not reach back into the parent's row.
        self.store["parent"] = {"provider": "copilot", "effort": "high"}
        SessionsMixin.carry_fork_meta("parent", "child", title="")
        self.store["child"]["effort"] = "low"
        self.assertEqual(self.store["parent"]["effort"], "high")


if __name__ == "__main__":
    unittest.main()
