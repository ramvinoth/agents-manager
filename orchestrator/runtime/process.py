"""Child-process plumbing shared by every runner: stdin messages, stdout reading, remote procs."""
import json
import posixpath
import queue
import shlex
import threading
import time

from orchestrator.config import CHAT_TIMEOUT
from orchestrator.remote import SSH, _remote_expand


def stream_user_message(proc, text):
    """Write one user message to a stream-json claude process."""
    msg = {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}}
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()


_STDOUT_EOF = object()


def iter_stdout_until(proc, idle_timeout, paused=None, poll=30):
    """Yield stdout lines, killing the turn only after `idle_timeout` of SILENCE.

    `for line in proc.stdout` blocks in readline() until the child writes, so a
    total-wall-clock deadline can only be checked when a line arrives; a child
    that goes silent mid-turn (a hung claude -p) parks the reader forever and
    the turn never ends. We drain stdout on a helper thread and pull lines
    through a queue with a per-wait timeout that RE-ARMS on every line, so the
    window measures the gap since the last output, not total run time. A
    genuinely-working agent (streaming assistant text / tool calls / results)
    runs indefinitely; only true silence longer than `idle_timeout` raises
    TimeoutError. Returns on clean EOF. Uniform for local pipes and the
    paramiko RemoteProc stream.

    Note: a long-running tool call is silent on the stream until it returns, so
    `idle_timeout` must exceed the longest legitimate quiet gap (see
    CHAT_IDLE_TIMEOUT).

    `paused()` true means the silence is the human's, not the child's: a
    question, plan or permission hook is holding the CLI until the owner
    answers. While paused the window does not run, and it re-arms in full once
    the answer lands. Those hooks bound their own wait (QUESTION_TIMEOUT,
    PERM_TIMEOUT), so a pause cannot park the turn forever."""
    q = queue.Queue()

    def _pump():
        try:
            for line in proc.stdout:
                q.put(line)
        finally:
            q.put(_STDOUT_EOF)

    threading.Thread(target=_pump, daemon=True).start()
    last = time.monotonic()
    while True:
        try:
            item = q.get(timeout=min(poll, idle_timeout))
        except queue.Empty:
            now = time.monotonic()
            if paused and paused():
                last = now
            elif now - last >= idle_timeout:
                raise TimeoutError(f"No output for {idle_timeout}s (idle timeout)")
            continue
        if item is _STDOUT_EOF:
            return
        last = time.monotonic()
        yield item


class RemoteProc:
    """Popen-like wrapper around a paramiko exec channel so the streaming run
    manager can drive a claude process over SSH exactly like a local one."""

    class _Stdin:
        def __init__(self, chan): self.chan = chan
        def write(self, s): self.chan.sendall(s.encode() if isinstance(s, str) else s)
        def flush(self): pass
        def close(self):
            try: self.chan.shutdown_write()
            except OSError: pass

    def __init__(self, hid, argv, cwd, shell_prefix="bash -lc", env=None):
        # Hold the per-host lock only for setup; the stream then runs on its own
        # dedicated channel, which paramiko multiplexes safely alongside other ops.
        # shell_prefix: Copilot passes "${SHELL:-bash} -ilc" so a version-managed
        # node (set up in the INTERACTIVE rc, e.g. macOS ~/.zshrc) is on PATH.
        # env: extra vars exported into the remote shell (paramiko exec does NOT
        # inherit the caller's environment), e.g. VIEWER_PERM_* for the perm tool.
        with SSH.lock_for(hid):
            c = SSH.get(hid)
            # Expand ~ against the remote home BEFORE quoting: a shlex-quoted
            # "~/dir" is single-quoted, which bash never tilde-expands, so the
            # cd would fail with "No such file or directory" and claude never
            # starts (the new-session picker hands us ~-relative paths).
            rcwd = _remote_expand(c["home"], cwd)
            self.chan = c["client"].get_transport().open_session()
            # Bound the run: a silent/wedged remote agent must raise (socket.timeout)
            # rather than block the run thread forever with the session stuck "busy".
            self.chan.settimeout(CHAT_TIMEOUT)
            exports = ""
            if env:
                exports = "".join(
                    "export " + k + "=" + shlex.quote(str(v)) + " && "
                    for k, v in env.items())
            shell = exports + "cd " + shlex.quote(rcwd) + " && exec " + " ".join(shlex.quote(a) for a in argv)
            if "/" in argv[0]:
                # An nvm-installed claude has a `#!/usr/bin/env node` shebang and
                # node lives beside it, outside the non-interactive PATH — put
                # the binary's own dir first so env can find node.
                shell = 'export PATH=' + shlex.quote(posixpath.dirname(argv[0])) + ':"$PATH" && ' + shell
            self.chan.exec_command(shell_prefix + " " + shlex.quote(shell))
        self.stdin = RemoteProc._Stdin(self.chan)
        self.stdout = self.chan.makefile("r", -1)
        self.stderr = self.chan.makefile_stderr("r", -1)
        self.returncode = None

    def poll(self):
        if self.chan.exit_status_ready():
            self.returncode = self.chan.recv_exit_status()
            return self.returncode
        return None

    def wait(self, timeout=None):
        self.returncode = self.chan.recv_exit_status()
        return self.returncode

    def _kill(self):
        try: self.chan.close()
        except OSError: pass

    send_signal = lambda self, sig: self._kill()
    terminate = lambda self: self._kill()
    kill = lambda self: self._kill()
