"""orchestrator.procctl — starting and stopping a local child process, on every platform.

POSIX interrupts a child with SIGINT and kills a process group with killpg.
Windows has neither: a child started with CREATE_NEW_PROCESS_GROUP is
interrupted with CTRL_BREAK_EVENT, and a tree is killed with taskkill /T.
Everything here is stdlib and safe to import on any platform.
"""
import os
import signal
import subprocess


def local_cwd(cwd):
    """The directory a local child runs in. Popen never expands "~" (callers
    default an unknown cwd to it, e.g. a resume or an inbox wake), so a bare
    "~" would fail with FileNotFoundError. Empty means home."""
    return os.path.expanduser(cwd or "~")


def interruptible_kwargs():
    """Popen keyword arguments a child needs for interrupt() to reach it.

    Windows: its own process group, the only way CTRL_BREAK_EVENT targets one
    child. POSIX: nothing — SIGINT goes to the pid, and the child stays in the
    server's process group so stopping the server stops its runs too.
    """
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {}


def interrupt(proc):
    """Ask a running child to stop as Ctrl-C would: SIGINT on POSIX,
    CTRL_BREAK_EVENT on Windows (the child must have been started with
    interruptible_kwargs(), and share the server's console). A child that
    cannot be interrupted is terminated instead. Never raises.

    proc is a Popen, or any Popen-like object (runtime.process.RemoteProc) whose
    signal methods do their own thing."""
    try:
        proc.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGINT)
    except (OSError, ValueError):
        terminate(proc)


def terminate(proc):
    """SIGTERM on POSIX, so the child can clean up. On Windows terminate() is
    already a hard TerminateProcess of the child alone, which would orphan the
    real program behind a .cmd shim — so a local child's whole tree goes."""
    if os.name == "nt" and isinstance(proc, subprocess.Popen):
        if proc.poll() is None:  # a reaped pid may already belong to someone else
            kill_tree(proc.pid)
        return
    try:
        proc.terminate()
    except OSError:
        pass


def kill(proc):
    """The last resort: a local child's whole tree, or the object's own kill()."""
    if isinstance(proc, subprocess.Popen):
        if proc.poll() is None:  # a reaped pid may already belong to someone else
            kill_tree(proc.pid)
        return
    try:
        proc.kill()
    except OSError:
        pass


def kill_tree(pid):
    """Kill pid and every process it started. Never raises.

    POSIX: SIGKILL the process group pid leads (a start_new_session or pty
    child); pid alone when it leads none. Windows: taskkill /T /F, since
    TerminateProcess would leave a .cmd shim's real program running.
    """
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)],
                           capture_output=True, timeout=15)
        except (OSError, subprocess.SubprocessError):
            pass
        return
    try:
        os.killpg(pid, signal.SIGKILL)
        return
    except OSError:
        pass
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
