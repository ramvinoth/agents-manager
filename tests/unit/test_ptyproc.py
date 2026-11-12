"""orchestrator.ptyproc — the one pseudo-terminal seam (stdlib pty on POSIX, ConPTY on
Windows). Every read runs on a thread with a deadline so a regression fails the
test instead of hanging the suite."""
import os
import sys
import tempfile
import threading
import time
import unittest

from orchestrator import ptyproc

POSIX = os.name != "nt"


def _output(proc, timeout=10):
    """Everything proc prints until end of output; kills it at the deadline."""
    out = []

    def drain():
        while True:
            chunk = proc.read(4096)
            if not chunk:
                return
            out.append(chunk)

    t = threading.Thread(target=drain, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        proc.kill(group=True)
        t.join(5)
    return b"".join(out)


def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


@unittest.skipUnless(POSIX, "stdlib pty backend")
class PosixPtyTest(unittest.TestCase):
    def test_spawn_echo_reads_output_and_exit_code(self):
        proc = ptyproc.spawn(["echo", "hello-pty"], 80, 24)
        self.assertIn(b"hello-pty", _output(proc))
        self.assertEqual(proc.wait(), 0)
        proc.close()

    def test_spawn_sets_and_resize_changes_the_window_size(self):
        # The child waits for a line, so it measures after each size was set.
        proc = ptyproc.spawn(["sh", "-c", "stty size; read x; stty size"], 120, 40)
        time.sleep(0.3)
        proc.resize(100, 30)
        proc.write(b"\n")
        out = _output(proc)
        self.assertEqual(proc.wait(), 0)
        proc.close()
        self.assertIn(b"30 100", out)

    def test_kill_stops_the_child(self):
        proc = ptyproc.spawn(["sleep", "30"], 80, 24)
        proc.kill()
        self.assertEqual(proc.wait(), -9)
        proc.close()

    def test_group_kill_takes_the_childs_helpers_with_it(self):
        proc = ptyproc.spawn(["sh", "-c", "sleep 30 & echo $!; wait"], 80, 24)
        line = proc.read(64)
        while not line.strip().splitlines() or not line.strip().splitlines()[0].isdigit():
            more = proc.read(64)
            if not more:
                break
            line += more
        helper = int(line.strip().splitlines()[0])
        self.assertTrue(_alive(helper))
        proc.kill(group=True)
        proc.wait()
        proc.close()
        deadline = time.time() + 5
        while _alive(helper) and time.time() < deadline:
            time.sleep(0.05)
        self.assertFalse(_alive(helper))

    def test_a_command_that_cannot_start_reports_why_and_exits_127(self):
        # 2026-10-17: a failed exec fell back into a copy of the server and the
        # sign-in flow sat at "starting" forever.
        proc = ptyproc.spawn(["/nonexistent/x"], 80, 24)
        out = _output(proc)
        self.assertEqual(proc.wait(), 127)
        proc.close()
        self.assertIn(b"Could not start /nonexistent/x", out)

    def test_fallback_runs_when_the_first_command_cannot_start(self):
        proc = ptyproc.spawn(["/nonexistent/x"], 80, 24, fallback=["echo", "fell-back"])
        out = _output(proc)
        self.assertEqual(proc.wait(), 0)
        proc.close()
        self.assertIn(b"fell-back", out)
        self.assertNotIn(b"Could not start", out)

    def test_env_and_cwd_reach_the_child(self):
        with tempfile.TemporaryDirectory() as d:
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PTYPROC_PROBE": "probe-value"}
            proc = ptyproc.spawn(["sh", "-c", 'echo "$PTYPROC_PROBE"; pwd -P'], 80, 24, cwd=d, env=env)
            out = _output(proc).decode()
            self.assertEqual(proc.wait(), 0)
            proc.close()
            self.assertIn("probe-value", out)
            self.assertIn(os.path.realpath(d), out)

    def test_write_after_close_raises_and_kill_does_not(self):
        proc = ptyproc.spawn(["sleep", "30"], 80, 24)
        proc.kill()
        proc.wait()
        proc.close()
        with self.assertRaises(OSError):
            proc.write(b"x")
        proc.kill()
        proc.resize(10, 10)
        proc.close()

    def test_login_shell_is_shell_dash_l_with_sh_fallback(self):
        self.assertEqual(ptyproc.login_shell({"SHELL": "/bin/zsh"}), (["/bin/zsh", "-l"], ["/bin/sh"]))
        self.assertEqual(ptyproc.login_shell({}), (["/bin/bash", "-l"], ["/bin/sh"]))


@unittest.skipUnless(sys.platform == "win32", "ConPTY backend")
class WindowsPtyTest(unittest.TestCase):
    def test_spawn_echo_reads_output_and_exit_code(self):
        proc = ptyproc.spawn(["cmd.exe", "/c", "echo hello-pty"], 80, 24)
        self.assertIn(b"hello-pty", _output(proc))
        self.assertEqual(proc.wait(), 0)
        proc.close()

    def test_resize_and_kill(self):
        proc = ptyproc.spawn(["cmd.exe"], 80, 24)
        proc.resize(100, 30)
        proc.kill(group=True)
        proc.wait()
        proc.close()

    def test_a_command_that_cannot_start_reports_why_and_exits_127(self):
        proc = ptyproc.spawn(["C:\\nonexistent\\x.exe"], 80, 24)
        out = _output(proc)
        self.assertEqual(proc.wait(), 127)
        self.assertIn(b"Could not start", out)

    def test_login_shell_is_comspec(self):
        self.assertEqual(ptyproc.login_shell({"COMSPEC": "C:\\Windows\\cmd.exe"}),
                         (["C:\\Windows\\cmd.exe"], None))


if __name__ == "__main__":
    unittest.main()
