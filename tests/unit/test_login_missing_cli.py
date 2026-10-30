"""A sign-in flow whose CLI is not installed must say so, not hang at "starting"
(2026-10-17: a customer box had no claude; the forked child failed exec, fell
back into a copy of the server, and the browser sat at "Starting login…")."""
import os
import threading
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
        self.assertIsNone(m.proc)

    @unittest.skipIf(os.name == "nt", "stty is POSIX; ConPTY sizing is covered in test_ptyproc")
    def test_sign_in_pty_is_wide_enough_not_to_wrap_the_url(self):
        # A failed exec (exit 127 + reason) is ptyproc's contract, tested there.
        # The child waits for a line so it reads the size after spawn set it.
        proc = login._pty_spawn(["sh", "-c", "read x; stty size"])
        proc.write(b"\n")
        out = []

        def drain():
            while True:
                chunk = proc.read(512)
                if not chunk:
                    return
                out.append(chunk)

        t = threading.Thread(target=drain, daemon=True)
        t.start()
        t.join(10)
        if t.is_alive():
            proc.kill()
        self.assertEqual(proc.wait(), 0)
        proc.close()
        self.assertIn(b"50 2000", b"".join(out))

if __name__ == "__main__":
    unittest.main()
