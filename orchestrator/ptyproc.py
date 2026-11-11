"""orchestrator.ptyproc — one child process on a pseudo-terminal, on every platform.

The single place the server touches a terminal device. POSIX uses the stdlib
pty (fork + exec: the child is a session leader with the pty as its
controlling terminal); Windows uses ConPTY through pywinpty. Each backend
imports its platform modules when it spawns, never at import time, so this
module — and everything that imports it — loads on Windows, macOS and Linux.

The contract is the same on both backends:
- spawn() never raises for a command that cannot start. The process reads
  "Could not start <program>: <reason>" and wait() returns 127, so a caller
  reports it like any other failed run instead of hanging at "starting".
- read() blocks, and returns b"" only at end of output (or on a read error).
- write() raises OSError once the terminal is gone.
- resize(), kill() and close() never raise.
"""
import os
import signal
import struct
import time

from orchestrator.procctl import kill_tree


def spawn(argv, cols, rows, cwd=None, env=None, fallback=None):
    """Start argv on a new cols x rows terminal and return its process.

    env is the child's whole environment (None inherits ours). fallback is a
    second argv tried when argv cannot start, e.g. /bin/sh behind a login shell.
    """
    argvs = [list(argv)] + ([list(fallback)] if fallback else [])
    backend = _WinPty if os.name == "nt" else _PosixPty
    return backend.spawn(argvs, int(cols), int(rows), cwd, env)


def login_shell(env):
    """The owner's interactive shell as (argv, fallback) for spawn(): $SHELL -l
    then /bin/sh on POSIX; %COMSPEC% (cmd.exe) on Windows, which has no login
    shell to fall back from."""
    if os.name == "nt":
        return [env.get("COMSPEC") or "cmd.exe"], None
    return [env.get("SHELL") or "/bin/bash", "-l"], ["/bin/sh"]


def _failure(program, err):
    return f"Could not start {program}: {err}\n".encode()


# ---- POSIX: stdlib pty -------------------------------------------------------

def _exec_child(argvs, cwd, env):
    """Runs in the forked child and never returns into the server: a failed exec
    would otherwise run on as a second copy of the viewer holding the pty open.
    It prints the reason and exits 127 instead."""
    try:
        if cwd:
            os.chdir(cwd)
        for argv in argvs[:-1]:
            try:
                _exec(argv, env)
            except Exception:
                pass  # fall through to the fallback
        _exec(argvs[-1], env)
    except BaseException as e:
        os.write(1, _failure(argvs[-1][0], e))
    finally:
        os._exit(127)


def _exec(argv, env):
    if env is None:
        os.execvp(argv[0], argv)
    else:
        os.execvpe(argv[0], argv, env)


class _PosixPty:
    def __init__(self, pid, fd):
        self.pid = pid
        self.fd = fd

    @classmethod
    def spawn(cls, argvs, cols, rows, cwd, env):
        import pty
        pid, fd = pty.fork()
        if pid == 0:
            _exec_child(argvs, cwd, env)
        proc = cls(pid, fd)
        proc.resize(cols, rows)
        return proc

    def read(self, n):
        try:
            return os.read(self.fd, n)
        except OSError:
            return b""

    def write(self, data):
        os.write(self.fd, data)

    def resize(self, cols, rows):
        import fcntl
        import termios
        try:
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except OSError:
            pass

    def kill(self, group=False):
        """SIGKILL the child; group=True takes its whole process group (the
        child is a session leader), so helpers it started die with it."""
        if group:
            kill_tree(self.pid)
            return
        try:
            os.kill(self.pid, signal.SIGKILL)
        except OSError:
            pass

    def wait(self):
        """Reap the child and return its exit code (-N when killed by signal N)."""
        try:
            _, status = os.waitpid(self.pid, 0)
        except ChildProcessError:
            return 0
        return os.waitstatus_to_exitcode(status)

    def close(self):
        try:
            os.close(self.fd)
        except OSError:
            pass


# ---- Windows: ConPTY via pywinpty --------------------------------------------

class _WinPty:
    """pywinpty's PtyProcess speaks str; this adapts it to the bytes contract."""

    def __init__(self, proc):
        self._p = proc
        self.pid = proc.pid

    @classmethod
    def spawn(cls, argvs, cols, rows, cwd, env):
        from winpty import PtyProcess
        err = None
        for argv in argvs:
            try:
                return cls(PtyProcess.spawn(argv, cwd=cwd, env=env, dimensions=(rows, cols)))
            except Exception as e:
                err = e
        return _Unstarted(_failure(argvs[-1][0], err))

    def read(self, n):
        while True:
            try:
                data = self._p.read(n)
            except (EOFError, OSError):
                return b""
            if data:
                return data.encode("utf-8")
            time.sleep(0.01)  # '' is pywinpty's "nothing yet", not end of output

    def write(self, data):
        try:
            self._p.write(data.decode("utf-8", "replace"))
        except EOFError as e:
            raise OSError(str(e)) from e

    def resize(self, cols, rows):
        try:
            self._p.setwinsize(rows, cols)
        except Exception:
            pass

    def kill(self, group=False):
        """TerminateProcess the child; group=True takes its whole process tree."""
        if group:
            kill_tree(self.pid)
            return
        try:
            os.kill(self.pid, signal.SIGTERM)  # TerminateProcess on Windows
        except OSError:
            pass

    def wait(self):
        code = self._p.wait()
        return code if isinstance(code, int) else 0

    def close(self):
        try:
            self._p.close(force=True)
        except Exception:
            pass


class _Unstarted:
    """A Windows command that never started, shaped like a finished process so
    callers see the same message and exit code 127 as the POSIX child's."""
    pid = None

    def __init__(self, output):
        self._out = output

    def read(self, n):
        out, self._out = self._out[:n], self._out[n:]
        return out

    def write(self, data):
        raise OSError("process is not running")

    def resize(self, cols, rows):
        pass

    def kill(self, group=False):
        pass

    def wait(self):
        return 127

    def close(self):
        pass
