"""viewer.procctl — stopping a local child on every platform (card 270).

POSIX keeps SIGINT and process-group kills; Windows gets CTRL_BREAK_EVENT for
a child in its own process group and `taskkill /T` for a tree. The Windows
branches are driven here by setting os.name, since no real Windows runs them.
"""
import os
import signal
import subprocess
import sys
import time
import unittest
from unittest import mock

from viewer import procctl


class _Fake:
    def __init__(self, send_raises=None):
        self.sent, self.terminated, self.killed = [], 0, 0
        self.send_raises = send_raises

    def send_signal(self, sig):
        if self.send_raises:
            raise self.send_raises
        self.sent.append(sig)

    def terminate(self):
        self.terminated += 1

    def kill(self):
        self.killed += 1


def _windows(test):
    """Run test as if on Windows: os.name, plus the Windows-only constants."""
    def run(self):
        with mock.patch.object(procctl.os, "name", "nt"), \
                mock.patch.object(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200, create=True), \
                mock.patch.object(signal, "CTRL_BREAK_EVENT", 1, create=True):
            test(self)
    return run


class InterruptTest(unittest.TestCase):
    def test_posix_needs_no_spawn_flags_and_sends_sigint(self):
        with mock.patch.object(procctl.os, "name", "posix"):
            self.assertEqual(procctl.interruptible_kwargs(), {})
            p = _Fake()
            procctl.interrupt(p)
        self.assertEqual(p.sent, [signal.SIGINT])

    @_windows
    def test_windows_gets_its_own_group_and_ctrl_break(self):
        self.assertEqual(procctl.interruptible_kwargs(), {"creationflags": 0x200})
        p = _Fake()
        procctl.interrupt(p)
        self.assertEqual(p.sent, [signal.CTRL_BREAK_EVENT])

    def test_a_child_that_cannot_be_interrupted_is_terminated(self):
        # Windows Popen raises ValueError for a signal it does not support;
        # a CTRL_BREAK that cannot be delivered raises OSError.
        for err in (ValueError("unsupported signal"), OSError("no console")):
            p = _Fake(send_raises=err)
            with mock.patch.object(procctl.os, "name", "posix"):
                procctl.interrupt(p)
            self.assertEqual(p.terminated, 1, err)


class StopTest(unittest.TestCase):
    def test_non_popen_objects_use_their_own_methods(self):
        p = _Fake()  # e.g. engine.RemoteProc over SSH
        procctl.terminate(p)
        procctl.kill(p)
        self.assertEqual((p.terminated, p.killed), (1, 1))

    @_windows
    def test_windows_terminate_and_kill_take_the_whole_tree(self):
        proc = mock.Mock(spec=subprocess.Popen, pid=4321)
        proc.poll.return_value = None
        with mock.patch.object(procctl.subprocess, "run") as run:
            procctl.terminate(proc)
            procctl.kill(proc)
        self.assertEqual([c.args[0] for c in run.call_args_list],
                         [["taskkill", "/T", "/F", "/PID", "4321"]] * 2)
        proc.terminate.assert_not_called()

    @_windows
    def test_an_exited_child_is_left_alone(self):
        # Its pid may already be another process's: never kill by a stale pid.
        proc = mock.Mock(spec=subprocess.Popen, pid=4321)
        proc.poll.return_value = 0
        with mock.patch.object(procctl.subprocess, "run") as run:
            procctl.terminate(proc)
            procctl.kill(proc)
        run.assert_not_called()

    @_windows
    def test_kill_tree_never_raises_when_taskkill_is_missing(self):
        with mock.patch.object(procctl.subprocess, "run", side_effect=FileNotFoundError):
            procctl.kill_tree(1)

    @unittest.skipIf(os.name == "nt", "process groups are POSIX")
    def test_posix_kill_tree_takes_the_group_and_its_grandchildren(self):
        # A group leader whose own child would outlive a plain kill of the leader.
        proc = subprocess.Popen([sys.executable, "-c",
                                 "import subprocess, sys, time;"
                                 "c = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']);"
                                 "print(c.pid, flush=True); time.sleep(60)"],
                                stdout=subprocess.PIPE, text=True, start_new_session=True)
        grandchild = int(proc.stdout.readline())
        procctl.kill_tree(proc.pid)
        self.assertEqual(proc.wait(10), -signal.SIGKILL)
        proc.stdout.close()
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                os.kill(grandchild, 0)
            except ProcessLookupError:
                return
            time.sleep(0.05)
        self.fail("grandchild survived the group kill")

    @unittest.skipIf(os.name == "nt", "process groups are POSIX")
    def test_posix_kill_tree_falls_back_to_the_pid_when_it_leads_no_group(self):
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        procctl.kill_tree(proc.pid)  # not a group leader: killpg fails with ESRCH
        self.assertEqual(proc.wait(10), -signal.SIGKILL)


if __name__ == "__main__":
    unittest.main()
