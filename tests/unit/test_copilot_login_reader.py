"""CopilotLoginManager drives `copilot login` through ONE reader loop, whether
the CLI runs on a local pty or on a remote host's SSH pty (card 270 folded the
two near-duplicate loops; _SshPty makes the channel look like a pty process)."""
import unittest
from unittest import mock

from orchestrator import login


class _Chan:
    """A paramiko-channel stand-in: canned output, then EOF and an exit code."""

    def __init__(self, chunks, code):
        self.chunks, self.code = list(chunks), code
        self.sent, self.closed = [], False

    def recv(self, n):
        return self.chunks.pop(0) if self.chunks else b""

    def sendall(self, data):
        self.sent.append(data)

    def recv_exit_status(self):
        return self.code

    def close(self):
        self.closed = True


DEVICE = (b"Visit https://github.com/login/device and enter ABCD-1234\r\n"
          b"Store the token in plaintext? (y/N) ")


class CopilotReaderTest(unittest.TestCase):
    def _run(self, proc):
        m = login.CopilotLoginManager()
        m.stage, m.proc = "starting", proc
        with mock.patch.object(m, "_logged_in", return_value=False):
            m._reader(proc)
        return m

    def test_remote_channel_device_flow_completes(self):
        chan = _Chan([DEVICE, b"Signed in successfully\r\n"], code=0)
        m = self._run(login._SshPty(chan))
        self.assertEqual((m.url, m.code, m.stage), ("https://github.com/login/device", "ABCD-1234", "done"))
        self.assertEqual(chan.sent, [b"y\n"])     # plaintext-token prompt answered once
        self.assertIsNone(m.proc)
        self.assertTrue(chan.closed)

    def test_remote_failure_reports_the_output(self):
        chan = _Chan([b"error: no platform package found\r\n"], code=1)
        m = self._run(login._SshPty(chan))
        self.assertEqual(m.stage, "error")
        self.assertIn("no platform package found", m.error)

    def test_local_pty_takes_the_same_loop(self):
        chan = _Chan([DEVICE], code=0)
        local = mock.Mock(wraps=login._SshPty(chan))  # any ptyproc-shaped process
        m = self._run(local)
        self.assertEqual((m.code, m.stage), ("ABCD-1234", "done"))
        local.wait.assert_called_once()
        local.close.assert_called_once()

    def test_a_cancelled_login_stops_its_reader(self):
        chan = _Chan([DEVICE], code=0)
        proc = login._SshPty(chan)
        m = login.CopilotLoginManager()
        m.stage, m.proc = "starting", proc
        m.cancel()
        m._reader(proc)                            # returns at once: no longer current
        self.assertEqual((m.stage, m.url), ("idle", None))
        self.assertTrue(chan.closed)

    def test_ssh_pty_never_raises_on_a_dead_channel(self):
        chan = mock.Mock()
        chan.recv.side_effect = OSError("closed")
        chan.recv_exit_status.side_effect = OSError("closed")
        chan.close.side_effect = OSError("closed")
        p = login._SshPty(chan)
        self.assertEqual((p.read(10), p.wait()), (b"", 0))
        p.kill(group=True)
        p.close()


if __name__ == "__main__":
    unittest.main()
