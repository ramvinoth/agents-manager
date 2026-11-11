"""The Codex agent runner."""
import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path

from orchestrator import procctl
from orchestrator.agents import agent_env
from orchestrator.config import CHAT_JOBS, CHAT_LOCK, CHAT_TIMEOUT
from orchestrator.login import codex_bin
from orchestrator.remote import remote_codex_bin
from orchestrator.runtime.chat import end_oneshot_inflight, record_inflight
from orchestrator.runtime.process import RemoteProc


def codex_session_meta(full_path):
    """(codex session id, cwd) from a Codex rollout's session_meta line."""
    sid, cwd = "", ""
    try:
        with open(full_path, errors="replace") as fh:
            for i, line in enumerate(fh):
                if i > 6:
                    break
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("type") == "session_meta":
                    p = d.get("payload") or {}
                    sid = p.get("id") or sid
                    cwd = p.get("cwd") or cwd
                    break
    except Exception:
        pass
    if cwd and not os.path.isdir(cwd):
        cwd = str(Path.home())
    return sid, (cwd or str(Path.home()))


def start_codex_run(session_id, codex_id, message, cwd, model="", host="local"):
    """Drive a Codex session with one headless turn: `codex exec resume <id> <msg>`.

    Codex appends to the same rollout file, which the poller renders (normalised).
    One-shot — no stdin steer/queue. host != 'local' runs `codex exec` on that SSH
    host via RemoteProc. stdin=DEVNULL avoids a hang locally."""
    remote = bool(host) and host != "local"
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if job and job["running"]:
            return False
        job = {"running": True, "returncode": None, "stderr": "", "stdout": "",
               "started": time.time(), "message": message, "queue": [], "proc": None,
               "turns": 0, "steered": 0, "stdin_open": False, "mode": "", "model": model,
               "cwd": cwd, "interrupted": False, "host": host, "agent": "codex"}
        CHAT_JOBS[session_id] = job
    record_inflight(session_id, job, {"codex_id": codex_id})

    def run():
        proc = None
        err = ""
        try:
            cmd = ["codex", "exec", "--skip-git-repo-check"]
            if model and re.fullmatch(r"[A-Za-z0-9._-]+", model):
                cmd += ["-m", model]
            cmd += ["resume", codex_id, message]
            if remote:
                cmd[0] = remote_codex_bin(host)
                proc = RemoteProc(host, cmd, cwd)
                with CHAT_LOCK:
                    job["proc"] = proc
                out = proc.stdout.read()          # blocks until the one-shot exits
                err = proc.stderr.read()
                # paramiko channel files yield bytes — decode before storing so
                # the status JSON stays serialisable.
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
                cmd[0] = codex_bin()
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
            err = "codex run timed out"
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
