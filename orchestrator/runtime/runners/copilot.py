"""The GitHub Copilot agent runner, local and remote."""
import os
import subprocess
import threading
import time
from pathlib import Path

from orchestrator import procctl
from orchestrator.agents import agent_env
from orchestrator.config import CHAT_JOBS, CHAT_LOCK, CHAT_TIMEOUT
from orchestrator.login import copilot_bin
from orchestrator.remote import remote_copilot_bin, remote_run_shell
from orchestrator.runtime.chat import end_oneshot_inflight, record_inflight
from orchestrator.runtime.process import RemoteProc


def copilot_session_meta(full_path):
    """(session id = the session DIR name, cwd) for driving a local Copilot
    session. Copilot's transcript is <id>/events.jsonl, so the id is the parent
    dir; cwd comes from the session's session.start (falls back to $HOME)."""
    from orchestrator.adapters import _peek
    cwd, _ = _peek("copilot", full_path)
    if not cwd or not os.path.isdir(cwd):
        cwd = str(Path.home())
    return full_path.parent.name, cwd


def start_copilot_run(session_id, message, cwd, host="local", model="", mode=""):
    """Drive a Copilot CLI session with one headless turn:
    `copilot --resume=<id> -p <msg> [--model <m>] [--mode plan | --allow-all-tools]`.
    Copilot appends to the same events.jsonl, which the poller renders (normalised).
    One-shot — no steer/queue. host != 'local' runs it on that SSH host via
    RemoteProc. Auth comes from the host's stored ~/.copilot token (or GH_TOKEN)."""
    from orchestrator.copilot import copilot_run_flags
    remote = bool(host) and host != "local"
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if job and job["running"]:
            return False
        job = {"running": True, "returncode": None, "stderr": "", "stdout": "",
               "started": time.time(), "message": message, "queue": [], "proc": None,
               "turns": 0, "steered": 0, "stdin_open": False, "mode": mode, "model": model,
               "cwd": cwd, "interrupted": False, "host": host, "agent": "copilot"}
        CHAT_JOBS[session_id] = job
    record_inflight(session_id, job)

    def run():
        proc = None
        err = ""
        try:
            cmd = ["copilot", "--resume=" + session_id, "-p", message] + copilot_run_flags(model, mode)
            if remote:
                cmd[0] = remote_copilot_bin(host)
                proc = RemoteProc(host, cmd, cwd, shell_prefix="${SHELL:-bash} -ilc")
                with CHAT_LOCK:
                    job["proc"] = proc
                out = proc.stdout.read()          # blocks until the one-shot exits
                err = proc.stderr.read()
                if isinstance(out, bytes):
                    out = out.decode("utf-8", "replace")
                if isinstance(err, bytes):
                    err = err.decode("utf-8", "replace")
                err = err or ""
                proc.wait()
                with CHAT_LOCK:
                    job["returncode"] = proc.returncode
                    job["stdout"] = (out or "")[-4000:]
            else:
                env = agent_env()
                try:  # per-host env vars (e.g. GH_TOKEN) so Copilot can authenticate
                    from orchestrator.hostenv import host_env
                    env.update(host_env(host))
                except Exception:
                    pass
                cmd[0] = copilot_bin()
                proc = subprocess.Popen(cmd, cwd=procctl.local_cwd(cwd), env=env, text=True,
                                        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        **procctl.interruptible_kwargs())
                with CHAT_LOCK:
                    job["proc"] = proc
                out, e = proc.communicate(timeout=CHAT_TIMEOUT)
                err = e or ""
                with CHAT_LOCK:
                    job["returncode"] = proc.returncode
                    job["stdout"] = (out or "")[-4000:]
        except subprocess.TimeoutExpired:
            procctl.kill(proc)
            err = "copilot run timed out"
            with CHAT_LOCK:
                job["returncode"] = -1
        except Exception as ex:
            err = str(ex)
            with CHAT_LOCK:
                job["returncode"] = -1
        finally:
            with CHAT_LOCK:
                job["running"] = False
                job["finished"] = time.time()
                job["stderr"] = err[-2000:]
            end_oneshot_inflight(session_id, job)

    threading.Thread(target=run, daemon=True).start()
    return True


def _remote_copilot_session_dirs(host):
    """Set of Copilot session ids on the remote that already have an events.jsonl."""
    cmd = 'for d in ~/.copilot/session-state/*/; do [ -f "$d/events.jsonl" ] && basename "$d"; done 2>/dev/null'
    out = remote_run_shell(host, cmd)
    txt = (out[1] if isinstance(out, tuple) else out) or ""
    return set(x.strip() for x in txt.splitlines() if x.strip())


def _start_copilot_new_remote(message, cwd, host):
    before = _remote_copilot_session_dirs(host)
    cmd = [remote_copilot_bin(host), "-p", message, "--allow-all-tools"]
    try:
        proc = RemoteProc(host, cmd, cwd, shell_prefix="${SHELL:-bash} -ilc")
    except Exception:
        return None
    new = None
    deadline = time.time() + 70
    while time.time() < deadline:
        diff = _remote_copilot_session_dirs(host) - before
        if diff:
            new = sorted(diff)[0]
            break
        if proc.poll() is not None:
            break
        time.sleep(1.5)
    if not new:
        return None
    job = {"running": True, "returncode": None, "stderr": "", "stdout": "",
           "started": time.time(), "message": message, "queue": [], "proc": proc,
           "turns": 0, "steered": 0, "stdin_open": False, "mode": "", "model": "",
           "cwd": cwd, "interrupted": False, "host": host, "agent": "copilot"}
    with CHAT_LOCK:
        CHAT_JOBS[new] = job
    record_inflight(new, job)

    def finalize():
        err = ""
        try:
            out = proc.stdout.read()
            e = proc.stderr.read()
            out = out.decode("utf-8", "replace") if isinstance(out, bytes) else out
            e = e.decode("utf-8", "replace") if isinstance(e, bytes) else e
            err = e or ""
            proc.wait()
            with CHAT_LOCK:
                job["returncode"] = proc.returncode
                job["stdout"] = (out or "")[-4000:]
        except Exception as ex:
            err = str(ex)
            with CHAT_LOCK:
                job["returncode"] = -1
        finally:
            with CHAT_LOCK:
                job["running"] = False
                job["finished"] = time.time()
                job["stderr"] = err[-2000:]
            end_oneshot_inflight(new, job)

    threading.Thread(target=finalize, daemon=True).start()
    return new, new + "/events.jsonl"


def start_copilot_new(message, cwd, host="local"):
    """Create a NEW Copilot session (`copilot -p <msg> --allow-all-tools`), find the
    session-state/<id>/events.jsonl it writes, register a chat job, and return
    (session_id, rel_path). Local or remote (SSH). None if none appears."""
    if host and host != "local":
        return _start_copilot_new_remote(message, cwd, host)
    from orchestrator.adapters import _root
    root = _root("copilot")
    before = {p.name for p in root.iterdir()} if root.is_dir() else set()
    env = agent_env()
    try:
        from orchestrator.hostenv import host_env
        env.update(host_env("local"))
    except Exception:
        pass
    try:
        proc = subprocess.Popen([copilot_bin(), "-p", message, "--allow-all-tools"], cwd=procctl.local_cwd(cwd), env=env,
                                text=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                **procctl.interruptible_kwargs())
    except Exception:
        return None

    new = None
    deadline = time.time() + 40
    while time.time() < deadline:
        if root.is_dir():
            for p in root.iterdir():
                if p.is_dir() and p.name not in before and (p / "events.jsonl").exists():
                    new = p
                    break
        if new or proc.poll() is not None:
            break
        time.sleep(0.3)
    if not new:
        return None

    session_id = new.name
    job = {"running": True, "returncode": None, "stderr": "", "stdout": "",
           "started": time.time(), "message": message, "queue": [], "proc": proc,
           "turns": 0, "steered": 0, "stdin_open": False, "mode": "", "model": "",
           "cwd": cwd, "interrupted": False, "host": "local", "agent": "copilot"}
    with CHAT_LOCK:
        CHAT_JOBS[session_id] = job
    record_inflight(session_id, job)

    def finalize():
        try:
            out, err = proc.communicate(timeout=CHAT_TIMEOUT)
            with CHAT_LOCK:
                job["returncode"] = proc.returncode
                job["stdout"] = (out or "")[-4000:]
                job["stderr"] = (err or "")[-2000:]
        except Exception as ex:
            with CHAT_LOCK:
                job["returncode"] = -1
                job["stderr"] = str(ex)[-2000:]
        finally:
            with CHAT_LOCK:
                job["running"] = False
                job["finished"] = time.time()
            end_oneshot_inflight(session_id, job)

    threading.Thread(target=finalize, daemon=True).start()
    return session_id, session_id + "/events.jsonl"
