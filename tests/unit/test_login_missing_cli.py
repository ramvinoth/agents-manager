"""A sign-in flow whose CLI is not installed must say so, not hang at "starting"
(2026-10-17: a customer box had no claude; the forked child failed exec, fell
back into a copy of the server, and the browser sat at "Starting login…")."""
import os
import time
import unittest
from unittest import mock

from viewer import login


class MissingCliTest(unittest.TestCase):
    def test_claude_login_reports_missing_cli(self):
        m = login.LoginManager()
        with mock.patch.object(login, "claude_bin", return_value="/nonexistent/claude"):
            m.start()
        d = m.poll()
        self.assertEqual(d["stage"], "error")
        self.assertIn("not installed", d["error"])
        self.assertIsNone(m.pid)

    def test_failed_exec_exits_child_with_reason(self):
        pid, fd = login._pty_spawn(["/nonexistent/x"])
        out = b""
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                chunk = os.read(fd, 512)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
        _, status = os.waitpid(pid, 0)
        os.close(fd)
        self.assertEqual(os.waitstatus_to_exitcode(status), 127)
        self.assertIn(b"Could not start /nonexistent/x", out)


if __name__ == "__main__":
    unittest.main()
