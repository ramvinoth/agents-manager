"""Agent template rules (viewer.agenttemplates): one validator for create and
edit, who sees a personal agent, who may change it."""
import unittest

from viewer import agenttemplates as at
from viewer.db import TEMPLATE_FIELDS


class TestFields(unittest.TestCase):
    def test_minimal_agent_gets_defaults(self):
        fields, err = at.fields_from({"name": "  Scout "})
        self.assertIsNone(err)
        self.assertEqual(set(fields), set(TEMPLATE_FIELDS))
        self.assertEqual((fields["name"], fields["category"], fields["icon"], fields["level"], fields["jobs"]),
                         ("Scout", "personal", "sparkle", "ic", []))

    def test_rejects(self):
        for body, needle in (({}, "Name"), ({"name": "x" * 81}, "under"),
                             ({"name": "a", "plugin": "../etc"}, "plugin"),
                             ({"name": "a", "lens": "nope"}, "lens"),
                             ({"name": "a", "level": "god"}, "level"),
                             ({"name": "a", "category": "general"}, "category"),
                             ({"name": "a", "jobs": "daily"}, "list"),
                             ({"name": "a", "jobs": [{"prompt": " "}]}, "no prompt"),
                             ({"name": "a", "jobs": [{"prompt": "p"}]}, "Job 1"),
                             ({"name": "a", "jobs": [{"prompt": "p", "interval": "nonsense"}]}, "Job 1")):
            fields, err = at.fields_from(body)
            self.assertIsNone(fields, body)
            self.assertIn(needle, err, body)

    def test_jobs_keep_the_typed_schedule(self):
        fields, err = at.fields_from({"name": "a", "level": "lead", "plugin": "cyber-security", "jobs": [
            {"prompt": "brief me", "cron": "0 9 * * *"}, {"prompt": "check", "interval": "30m"}]})
        self.assertIsNone(err)
        self.assertEqual(fields["jobs"], [{"prompt": "brief me", "cron": "0 9 * * *"},
                                          {"prompt": "check", "interval": 1800}])


class TestOwnership(unittest.TestCase):
    OWNER, OTHER = {"id": 4, "role": "owner"}, {"id": 7, "role": "viewer"}

    def test_visibility(self):
        self.assertTrue(at.visible({"owner_user_id": None}, 7))
        self.assertTrue(at.visible({"owner_user_id": 7}, 7))
        self.assertFalse(at.visible({"owner_user_id": 4}, 7))
        self.assertFalse(at.visible({"owner_user_id": 4}, None))

    def test_editable(self):
        self.assertFalse(at.editable({"is_builtin": True, "owner_user_id": None}, self.OWNER))
        self.assertTrue(at.editable({"is_builtin": False, "owner_user_id": 7}, self.OTHER))
        self.assertFalse(at.editable({"is_builtin": False, "owner_user_id": 7}, self.OWNER))
        # A shared, pre-ownership user agent: the install owner may tend it.
        self.assertTrue(at.editable({"is_builtin": False, "owner_user_id": None}, self.OWNER))
        self.assertFalse(at.editable({"is_builtin": False, "owner_user_id": None}, self.OTHER))

    def test_copy(self):
        src = {"id": 1, "is_builtin": True, "name": "Coach", "description": "d", "category": "personal", "icon": "x",
               "system_prompt": "sp", "goal": "g", "model": "", "jobs": None, "plugin": "", "lens": "", "level": "ic"}
        copy = at.copy_fields(src)
        self.assertEqual((copy["name"], copy["jobs"], copy["system_prompt"]), ("Coach copy", [], "sp"))
        self.assertEqual(set(copy), set(TEMPLATE_FIELDS))


if __name__ == "__main__":
    unittest.main()
