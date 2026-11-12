"""The pi agent runner."""
import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path

from orchestrator import procctl
from orchestrator.agents import agent_env, find_agent_bin
from orchestrator.config import CHAT_JOBS, CHAT_LOCK, CHAT_TIMEOUT
from orchestrator.runtime.chat import end_oneshot_inflight, record_inflight


def pi_session_uuid(stem):
    """Pi filenames are '<ts>_<uuid>' — the trailing UUID is what `pi --session` wants."""
    return stem.rsplit("_", 1)[-1] if "_" in stem else stem


def pi_session_cwd(full_path):
    """The working directory recorded in a Pi session's opening 'session' line."""
    try:
        with open(full_path, errors="replace") as fh:
            for i, line in enumerate(fh):
                if i > 40:
                    break
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("type") == "session" and d.get("cwd"):
                    return d["cwd"] if os.path.isdir(d["cwd"]) else str(Path.home())
    except Exception:
        pass
    return str(Path.home())


def pi_session_provider_model(full_path):
    """(provider, modelId) recorded in a Pi session — the most recent wins.

    Passed explicitly on resume so auth resolves and the right model is used
    (matching the invocation validated to work headlessly)."""
    provider = model = ""
    try:
        with open(full_path, errors="replace") as fh:
            for i, line in enumerate(fh):
                if i > 400:
                    break
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("type") == "model_change":
                    provider = d.get("provider") or provider
                    model = d.get("modelId") or model
                m = d.get("message") or {}
                if isinstance(m, dict) and m.get("role") == "assistant":
                    provider = m.get("provider") or provider
                    model = m.get("model") or model
    except Exception:
        pass
    return provider, model


def start_pi_run(session_id, session_uuid, message, cwd, provider="", model=""):
    """Drive a Pi session with one headless turn: `pi -p --session <uuid> <msg>`.

    Pi appends to the same session file, which the poller renders (normalised to
    the Claude schema). One-shot — no stdin steer/queue like Claude. Local only.
    Lean flags skip the heavy playwright MCP; provider/model come from the
    session so auth resolves (mirrors the headless invocation that validated).
    """
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if job and job["running"]:
            return False
        job = {"running": True, "returncode": None, "stderr": "", "stdout": "",
               "started": time.time(), "message": message, "queue": [], "proc": None,
               "turns": 0, "steered": 0, "stdin_open": False, "mode": "", "model": model,
               "cwd": cwd, "interrupted": False, "host": "local", "agent": "pi"}
        CHAT_JOBS[session_id] = job
    record_inflight(session_id, job, {"uuid": session_uuid, "provider": provider})

    def run():
        proc = None
        err = ""
        try:
            env = agent_env()
            cmd = [find_agent_bin("pi") or "pi", "-p", "--offline", "-ne", "-ns", "-np", "--no-themes"]
            if re.fullmatch(r"[A-Za-z0-9._-]+", provider or ""):
                cmd += ["--provider", provider]
            if re.fullmatch(r"[A-Za-z0-9._/-]+", model or ""):
                cmd += ["--model", model]
            cmd += ["--session", session_uuid, message]
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
            err = "pi run timed out"
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
