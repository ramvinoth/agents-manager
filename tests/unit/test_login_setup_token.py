"""`claude setup-token` sign-in, end to end over a real pty (card 204).

Claude Code 2.1.302 draws with cursor moves instead of spaces, and its diff
renderer skips cells that already hold the right character. On a customer box
the token line arrived as `sk-ant-\\x1b[10Gat01-…` — the `o` was left on screen
from the previous frame — so deleting escape codes produced `sk-ant-at01-…`, the
token regex never matched, nothing was saved, and the flow still said "done"
because the CLI exited 0.

A fake CLI replays a capture shaped like 2.1.302's output (layout and escape
codes as captured from a real `claude setup-token`; OAuth parameters and the
token are dummies) through LoginManager on a pty.
"""
import os
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest import mock

from orchestrator import login
from orchestrator.config import ANSI_RE

DUMMY_TOKEN = "sk-ant-oat01-" + ("TESTONLY0123456789abcdefghij_-" * 4)[:95]   # 108 chars
URL = ("https://claude.com/cai/oauth/authorize?code=true&client_id=00000000-0000-0000-0000-000000000000"
       "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback"
       "&scope=user%3Ainference&code_challenge=DUMMYCHALLENGE&code_challenge_method=S256&state=DUMMYSTATE")

# Before the code: welcome, the sign-in URL (OSC 8 hyperlink + visible text), paste prompt.
PHASE1 = (
    "\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?25l\x1b[?2004h\x1b[?2031h\x1b[?1004h"
    "Welcome\x1b[9Gto\x1b[12GClaude\x1b[19GCode\x1b[24Gv2.1.302\r\r\n"
    "\r\r\n"
    "\x1b[2GThis\x1b[7Gwill\x1b[12Gguide\x1b[18Gyou\x1b[22Gthrough\x1b[30Glong-lived\x1b[41G(1-year)"
    "\x1b[50Gauth\x1b[55Gtoken\x1b[61Gsetup\x1b[67Gfor\x1b[71Gyour\x1b[76GClaude\x1b[83Gaccount.\r\r\n"
    "\r\r\n"
    "\x1b[>0q\x1b[?u\x1b]7501;?\x07\x1b[c"
    "\x1b[2G✻\x1b[4GOpening\x1b[12Gbrowser\x1b[20Gto\x1b[23Gsign\x1b[28Gin…\r\r\n"
    "\r\x1b[1C\x1b[1A✶\r\r\n"
    "\r\x1b[1C\x1b[1ABrowser didn't open?\x1b[23GUse the url\x1b[35Gbelow\x1b[41Gto\x1b[44Gsign\x1b[49Gin\r\r\n"
    "\r\r\n"
    "\x1b]8;id=13gdwzg;" + URL + "\x07" + URL + "\x1b]8;;\x07\r\r\n"
    "\r\r\n"
    "\x1b[2GPaste\x1b[8Gcode\x1b[13Ghere\x1b[18Gif\x1b[21Gprompted\x1b[30G>\r\r\n"
).encode()

# After the code: the dynamic region is redrawn from the top. The first frame puts
# "Got code" there; the token frame then skips the cell that already holds "o".
_UP = "\x1b[9A"
PHASE2_TOKEN = (
    _UP + "\r\x1b[2K\x1b[2G✻\x1b[4GGot code,\x1b[14Gcreating\x1b[23Gtoken…\r\r\n"
    "\x1b[1A\r\x1b[2Gsk-ant-\x1b[10G" + DUMMY_TOKEN[len("sk-ant-o"):] + "\x1b[K\r\r\n"
    "\r\r\n"
    "\x1b[2GStore\x1b[8Gthis\x1b[13Gtoken\x1b[19Gsecurely.\x1b[29GYou\x1b[33Gwon't\x1b[39Gbe\x1b[42Gable"
    "\x1b[47Gto\x1b[50Gsee\x1b[54Git\x1b[57Gagain.\r\r\n"
    "\r\r\n"
    "\x1b[2GPress\x1b[8GEnter\x1b[14Gto\x1b[17Gexit\r\r\n"
).encode()

PHASE2_NO_TOKEN = (
    _UP + "\r\x1b[2K\x1b[2G✓\x1b[4GLogin\x1b[10Gsuccessful\r\r\n"
).encode()

# The fake CLI: raw tty like Ink, prints phase 1, reads the pasted code up to
# Enter, prints phase 2, waits for a keypress, exits 0.
FAKE_CLI = textwrap.dedent("""\
    import os, sys, tty
    tty.setraw(0)
    def wait_enter():
        while True:
            c = os.read(0, 1)
            if not c or c in (b"\\r", b"\\n"):
                return
    one = open(os.environ["FAKE_PHASE1"], "rb").read()
    for i in range(0, len(one), 97):   # small writes: sequences split across reads
        os.write(1, one[i:i + 97])
    wait_enter()
    os.write(1, open(os.environ["FAKE_PHASE2"], "rb").read())
    wait_enter()
    sys.exit(0)
""")


class SetupTokenFlowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.token_file = self.tmp / "token"
        cli = self.tmp / "claude"
        cli.write_text(f"#!{sys.executable}\n" + FAKE_CLI)
        cli.chmod(0o755)
        (self.tmp / "p1").write_bytes(PHASE1)
        self.patches = [
            mock.patch.object(login, "claude_bin", return_value=str(cli)),
            mock.patch.object(login, "VIEWER_TOKEN_FILE", self.token_file),
            mock.patch.dict(os.environ, {"FAKE_PHASE1": str(self.tmp / "p1"),
                                         "FAKE_PHASE2": str(self.tmp / "p2")}),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        for f in self.tmp.iterdir():
            f.unlink()
        self.tmp.rmdir()

    def _run(self, phase2):
        (self.tmp / "p2").write_bytes(phase2)
        m = login.LoginManager()
        m.start()
        d = self._wait(m, lambda d: d["stage"] != "starting")
        self.assertEqual(d["stage"], "url", d)
        self.assertEqual(d["url"], URL)
        self.assertTrue(m.submit_code("dummy-code#dummy-state"))
        d = self._wait(m, lambda d: d["stage"] in ("done", "error") and m.proc is None)
        return m, d

    def _wait(self, m, cond, timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            d = m.poll()
            if cond(d):
                return d
            time.sleep(0.05)
        m.cancel()
        self.fail(f"login flow stuck: {m.poll()}")

    def test_capture_reproduces_the_bug_for_escape_stripping(self):
        # Non-vacuous: the old reader (delete escape codes) loses the token here.
        stripped = ANSI_RE.sub("", (PHASE1 + PHASE2_TOKEN).decode())
        self.assertNotIn(DUMMY_TOKEN, stripped)
        self.assertNotRegex(stripped, r"sk-ant-oat[0-9A-Za-z_-]{20,}")

    def test_token_drawn_with_cursor_moves_is_saved(self):
        m, d = self._run(PHASE2_TOKEN)
        self.assertEqual(d["stage"], "done", d)
        self.assertEqual(self.token_file.read_text(), DUMMY_TOKEN)
        self.assertEqual(self.token_file.stat().st_mode & 0o777, 0o600)

    def test_clean_exit_without_token_is_an_error_not_done(self):
        m, d = self._run(PHASE2_NO_TOKEN)
        self.assertEqual(d["stage"], "error", d)
        self.assertEqual(d["error"], login.NO_TOKEN_ERROR)
        self.assertFalse(self.token_file.exists())


class DrawnMatchTest(unittest.TestCase):
    def test_token_still_being_drawn_is_not_taken(self):
        s = login.Screen(cols=2000)
        s.feed(DUMMY_TOKEN[:40].encode())
        self.assertIsNone(login._drawn_match(s, login._TOKEN_RE))
        s.feed(DUMMY_TOKEN[40:].encode())
        self.assertIsNone(login._drawn_match(s, login._TOKEN_RE))
        s.feed(b"\r\r\n")
        self.assertEqual(login._drawn_match(s, login._TOKEN_RE), DUMMY_TOKEN)

    def test_token_autowrapped_by_a_narrow_terminal_is_joined(self):
        s = login.Screen(cols=50)
        s.feed(b"\x1b[2G" + DUMMY_TOKEN.encode() + b"\r\r\n\x1b[2GStore this token\r\r\n")
        self.assertEqual(login._drawn_match(s, login._TOKEN_RE), DUMMY_TOKEN)

    def test_exit_accepts_a_token_at_the_cursor(self):
        s = login.Screen(cols=2000)
        s.feed(DUMMY_TOKEN.encode())
        self.assertEqual(login._drawn_match(s, login._TOKEN_RE, final=True), DUMMY_TOKEN)


if __name__ == "__main__":
    unittest.main()
