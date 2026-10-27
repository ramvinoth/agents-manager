"""Unread follows the last message, not the transcript file's mtime.

Claude Code appends bookkeeping records (cost-state, last-prompt, custom-title…)
with no `timestamp` when a session is resumed or exits. Those bumped the file's
mtime, so a chat nobody had spoken in for days lit up unread. Regression for the
LiteLLM / agents-wsl2 chats showing unread with no new message.
"""
import json
import os
import unittest
from unittest.mock import patch

from viewer import engine
from viewer.routes.sessions import SessionsMixin


def _iso(epoch):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat().replace("+00:00", "Z")


class TestNewer(unittest.TestCase):
    def test_keeps_the_later_message_time(self):
        t = engine._newer(None, {"type": "user", "timestamp": _iso(100)})
        self.assertEqual(engine._newer(t, {"type": "assistant", "timestamp": _iso(50)}), 100)

    def test_bookkeeping_and_bad_timestamps_do_not_count(self):
        for obj in ({"type": "cost-state"}, {"type": "last-prompt", "timestamp": _iso(999)},
                    {"type": "user", "timestamp": "not a date"}, {"type": "user"}):
            self.assertEqual(engine._newer(7, obj), 7)


class TestListSessionsLastMessage(unittest.TestCase):
    def _write(self, tmp, records, mtime):
        proj = os.path.join(tmp, "projects", "-p")
        os.makedirs(proj)
        f = os.path.join(proj, "abc.jsonl")
        with open(f, "w") as fh:
            for r in records:
                fh.write(json.dumps(r) + "\n")
        os.utime(f, (mtime, mtime))
        return os.path.join(tmp, "projects")

    def _list(self, records, mtime=10_000):
        import tempfile, pathlib
        with tempfile.TemporaryDirectory() as tmp:
            root = self._write(tmp, records, mtime)
            with patch.object(engine, "CLAUDE_DIR", pathlib.Path(root)):
                return engine.LocalHost().list_sessions()[0]

    def test_bookkeeping_after_the_last_message_is_ignored(self):
        s = self._list([{"type": "user", "timestamp": _iso(1000), "message": {"content": "hi"}},
                        {"type": "assistant", "timestamp": _iso(2000), "message": {"content": "yo"}},
                        {"type": "cost-state"}, {"type": "last-prompt"}])
        self.assertEqual(s["modified"], 10_000)
        self.assertEqual(s["last_message"], 2000)

    def test_a_small_file_is_scanned_past_its_first_200_lines(self):
        recs = [{"type": "progress"}] * 300 + [{"type": "user", "timestamp": _iso(3000),
                                                "message": {"content": "late"}}]
        s = self._list(recs)
        self.assertEqual(s["last_message"], 3000)
        self.assertEqual(s["preview"], "You: late")

    def test_no_message_falls_back_to_mtime(self):
        self.assertEqual(self._list([{"type": "cost-state"}])["last_message"], 10_000)


class TestOverlayUnread(unittest.TestCase):
    def _unread(self, sessions, seen):
        with patch("viewer.db.session_meta_all", return_value={}), \
             patch("viewer.db.session_seen_get", return_value=seen):
            m = SessionsMixin.__new__(SessionsMixin)
            m.session_busy = lambda sid: False
            m._overlay_meta(sessions, "user:r", "claude")
        return {s["id"]: s["unread"] for s in sessions}

    def test_mtime_bump_without_a_message_stays_read(self):
        got = self._unread([{"id": "a", "last_message": 100, "modified": 500}], {"a": 200})
        self.assertFalse(got["a"])

    def test_a_new_message_is_unread(self):
        self.assertTrue(self._unread([{"id": "a", "last_message": 300}], {"a": 200})["a"])

    def test_never_opened_chat_is_unread_only_after_tracking_began(self):
        got = self._unread([{"id": "new", "last_message": 300}, {"id": "old", "last_message": 50},
                            {"id": "seen", "last_message": 90}], {"seen": 100})
        self.assertEqual(got, {"new": True, "old": False, "seen": False})

    def test_reader_who_never_opened_anything_sees_nothing_unread(self):
        self.assertFalse(self._unread([{"id": "a", "last_message": 300}], {})["a"])

    def test_remote_listing_falls_back_to_mtime(self):
        s = [{"id": "a", "modified": 300}]
        self.assertTrue(self._unread(s, {"a": 200})["a"])
        self.assertEqual(s[0]["last_message"], 300)  # clients sort by it
