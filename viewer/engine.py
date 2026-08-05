"""viewer.engine — agent runners (claude/codex/pi), chat control, loops,
session summary/analysis, skill scans, and the Host local/remote seam."""
import json
import os
import posixpath
import re
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from viewer.config import (
    CHAT_JOBS, CHAT_LOCK, CHAT_TIMEOUT, CLAUDE_DIR, PERM_TIMEOUT, PORT, QUESTION_TIMEOUT, VIEWER_TOKEN_FILE, claude_bin,
)
from viewer.browser import (
    ensure_mcp_browser,
)
from viewer.login import (
    auth_status, codex_bin,
)
from viewer.remote import (
    SSH, _remote_expand, remote_capabilities, remote_claude_bin, remote_codex_bin, remote_copilot_bin, remote_extract_cwd, remote_fs, remote_full_path, remote_list_sessions, remote_mcp_save, remote_projects, remote_resolve, remote_run_python, remote_run_shell,
)


# Claude encodes a session's cwd as its project-dir name (every "/" -> "-"); the
# current user's home prefix, encoded the same way, lets us show "~/…" generically.
_HOME_ENC = str(Path.home()).replace("/", "-")


# ===== Loops (recurring prompts per session) and session meta =====
LOOPS_FILE = Path.home() / ".claude" / ".viewer-loops.json"
META_FILE = Path.home() / ".claude" / ".viewer-meta.json"
LOOPS_LOCK = threading.Lock()


def load_json_file(path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def save_json_file(path, data):
    # SESSION_META/HOSTS/LOOPS aren't lock-guarded across their scattered mutation
    # sites; a concurrent add/remove of a key while we dump raises "dict changed
    # size during iteration". Retry the snapshot, then write atomically (temp +
    # os.replace) so a crash mid-write can't corrupt or drop the file.
    text = None
    for _ in range(5):
        try:
            text = json.dumps(data, indent=1)
            break
        except RuntimeError:
            time.sleep(0.005)
    if text is None:
        return
    try:
        tmp = path.parent / (path.name + ".tmp")
        tmp.write_text(text)
        os.replace(tmp, path)
    except Exception:
        pass


LOOPS = load_json_file(LOOPS_FILE, {})     # id -> {session, path, prompt, interval, nextRun, runs, lastRc, enabled}
SESSION_META = load_json_file(META_FILE, {})  # session_id -> {goal, systemPrompt}


def _session_title(session_id):
    """The session's display name, matching the chat list: a custom title if set,
    else the agent name, else the first user message, else ''. Best-effort."""
    try:
        matches = list(CLAUDE_DIR.glob(f"*/{session_id}.jsonl"))
        if not matches:
            return ""
        title = first_user = ""
        with open(matches[0], errors="replace") as f:
            for i, line in enumerate(f):
                if i > 200 or title:
                    break
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                t = obj.get("type")
                if t == "custom-title" and obj.get("customTitle"):
                    title = obj["customTitle"]
                elif t == "agent-name" and obj.get("agentName"):
                    title = obj["agentName"]
                elif not first_user and t == "user":
                    msg = (obj.get("message") or {}).get("content")
                    if isinstance(msg, str):
                        first_user = msg
                    elif isinstance(msg, list):
                        first_user = " ".join(
                            b.get("text", "") for b in msg if isinstance(b, dict) and b.get("type") == "text"
                        )
        return " ".join((title or first_user).split())[:60]
    except Exception:
        return ""


def _push_label(session_id, cwd=""):
    """A short human title for a push notification: the session's display name
    (matching the chat list), else its goal, else the working-directory basename,
    else a short session id."""
    name = _session_title(session_id)
    if name:
        return name
    meta = SESSION_META.get(session_id) or {}
    goal = (meta.get("goal") or "").strip()
    if goal:
        return goal[:60]
    if cwd:
        base = os.path.basename(cwd.rstrip("/"))
        if base:
            return base
    return f"Chat {str(session_id)[:8]}"


def parse_interval(text):
    """'30s' / '5m' / '2h' / plain seconds -> seconds (min 30, max 24h)."""
    text = str(text).strip().lower()
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([smh]?)", text)
    if not m:
        return None
    val = float(m.group(1)) * {"": 1, "s": 1, "m": 60, "h": 3600}[m.group(2)]
    return int(min(max(val, 30), 86400))


CHAT_JOB_TTL = 1800  # keep a finished chat job ~30 min for the UI to read final status


def loop_scheduler(launch):
    """Background thread: fire due loops, and reap finished chat jobs so
    CHAT_JOBS doesn't grow unbounded (one entry per session ever driven)."""
    while True:
        time.sleep(5)
        now = time.time()
        with CHAT_LOCK:
            # Reap from when the run FINISHED, not when it started — a long run
            # otherwise loses its final status seconds after completing.
            stale = [sid for sid, j in CHAT_JOBS.items()
                     if not j.get("running") and now - j.get("finished", j.get("started", now)) > CHAT_JOB_TTL]
            for sid in stale:
                CHAT_JOBS.pop(sid, None)
        due = []
        with LOOPS_LOCK:
            for lid, lp in LOOPS.items():
                if lp.get("enabled", True) and now >= lp.get("nextRun", 0):
                    job = CHAT_JOBS.get(lp["session"])
                    if job and job["running"]:
                        lp["nextRun"] = now + 30  # session busy; retry shortly
                        continue
                    lp["nextRun"] = now + lp["interval"]
                    lp["runs"] = lp.get("runs", 0) + 1
                    lp["lastRun"] = now
                    due.append(dict(lp, id=lid))
            if due:
                save_json_file(LOOPS_FILE, LOOPS)
        for lp in due:
            try:
                launch(lp["session"], lp["path"], lp["prompt"], lp.get("model", ""))
            except Exception:
                pass


def frontmatter_description(path):
    """Pull `description:` out of a markdown file's YAML frontmatter."""
    try:
        with open(path, "r", errors="replace") as f:
            if f.readline().strip() != "---":
                return ""
            for _ in range(50):
                line = f.readline()
                if not line or line.strip() == "---":
                    break
                if line.strip().startswith("description:"):
                    val = line.split("description:", 1)[1].strip().strip("\"'")
                    if val in (">", "|", ">-", "|-", ""):
                        # Folded/literal block scalar: take the first indented line.
                        nxt = f.readline()
                        return nxt.strip().strip("\"'") if nxt.startswith((" ", "\t")) else ""
                    return val
    except Exception:
        pass
    return ""


def scan_command_dir(base, source, cmds):
    """Collect slash commands from a .claude/commands directory (subdirs become namespaces)."""
    if not base.is_dir():
        return
    try:
        for f in base.rglob("*.md"):
            name = str(f.relative_to(base).with_suffix("")).replace(os.sep, ":")
            cmds.setdefault(name, {"name": name, "description": frontmatter_description(f), "source": source})
    except Exception:
        pass


def scan_skill_dir(base, source, cmds):
    """Collect skills (each invocable as /<name>) from a .claude/skills directory."""
    if not base.is_dir():
        return
    try:
        for f in base.glob("*/SKILL.md"):
            name = f.parent.name
            cmds.setdefault(name, {"name": name, "description": frontmatter_description(f), "source": source})
    except Exception:
        pass


def stream_user_message(proc, text):
    """Write one user message to a stream-json claude process."""
    msg = {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}}
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()


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


# ===== Live browser view (CDP screencast over SSH) =====
#
# A persistent Chrome/Chromium runs on the host with --remote-debugging-port
# bound to 127.0.0.1 only; we reach it through the pooled SSH connection via a
# direct-tcpip channel (no port is ever exposed on the network). Frames come
# from CDP Page.startScreencast and are relayed to the UI as an MJPEG stream
# (multipart/x-mixed-replace), which a plain <img> renders live. Pointing the
# host's Playwright MCP at the same port (--cdp-endpoint) makes the agent
# drive the browser the user is watching.

def _pi_session_uuid(stem):
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

    def run():
        proc = None
        err = ""
        try:
            env = dict(os.environ)
            env["PATH"] = f"{Path.home()}/.local/bin:/usr/local/bin:/usr/bin:" + env.get("PATH", "")
            cmd = ["pi", "-p", "--offline", "-ne", "-ns", "-np", "--no-themes"]
            if re.fullmatch(r"[A-Za-z0-9._-]+", provider or ""):
                cmd += ["--provider", provider]
            if re.fullmatch(r"[A-Za-z0-9._/-]+", model or ""):
                cmd += ["--model", model]
            cmd += ["--session", session_uuid, message]
            proc = subprocess.Popen(cmd, cwd=cwd, env=env, text=True,
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            with CHAT_LOCK:
                job["proc"] = proc
            out, e = proc.communicate(timeout=CHAT_TIMEOUT)
            err = e or ""
            with CHAT_LOCK:
                job["returncode"] = proc.returncode
                job["stdout"] = (out or "")[-4000:]
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except Exception:
                pass
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

    threading.Thread(target=run, daemon=True).start()
    return True


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
                env = dict(os.environ)
                env["PATH"] = f"{Path.home()}/.local/bin:/usr/local/bin:/usr/bin:" + env.get("PATH", "")
                cmd[0] = codex_bin()
                proc = subprocess.Popen(cmd, cwd=cwd, env=env, text=True,
                                        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                with CHAT_LOCK:
                    job["proc"] = proc
                out, e = proc.communicate(timeout=CHAT_TIMEOUT)
                err = e or ""
                with CHAT_LOCK:
                    job["returncode"] = proc.returncode
                    job["stdout"] = (out or "")[-4000:]
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except Exception:
                pass
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

    threading.Thread(target=run, daemon=True).start()
    return True


def copilot_session_meta(full_path):
    """(session id = the session DIR name, cwd) for driving a local Copilot
    session. Copilot's transcript is <id>/events.jsonl, so the id is the parent
    dir; cwd comes from the session's session.start (falls back to $HOME)."""
    from viewer.adapters import _peek
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
    from viewer.copilot import copilot_run_flags
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
                env = dict(os.environ)
                env["PATH"] = f"{Path.home()}/.local/bin:/usr/local/bin:/usr/bin:" + env.get("PATH", "")
                try:  # per-host env vars (e.g. GH_TOKEN) so Copilot can authenticate
                    from viewer.hostenv import host_env
                    env.update(host_env(host))
                except Exception:
                    pass
                proc = subprocess.Popen(cmd, cwd=cwd, env=env, text=True,
                                        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                with CHAT_LOCK:
                    job["proc"] = proc
                out, e = proc.communicate(timeout=CHAT_TIMEOUT)
                err = e or ""
                with CHAT_LOCK:
                    job["returncode"] = proc.returncode
                    job["stdout"] = (out or "")[-4000:]
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except Exception:
                pass
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

    threading.Thread(target=finalize, daemon=True).start()
    return new, new + "/events.jsonl"


def start_copilot_new(message, cwd, host="local"):
    """Create a NEW Copilot session (`copilot -p <msg> --allow-all-tools`), find the
    session-state/<id>/events.jsonl it writes, register a chat job, and return
    (session_id, rel_path). Local or remote (SSH). None if none appears."""
    if host and host != "local":
        return _start_copilot_new_remote(message, cwd, host)
    from viewer.adapters import _root
    root = _root("copilot")
    before = {p.name for p in root.iterdir()} if root.is_dir() else set()
    env = dict(os.environ)
    env["PATH"] = f"{Path.home()}/.local/bin:/usr/local/bin:/usr/bin:" + env.get("PATH", "")
    try:
        from viewer.hostenv import host_env
        env.update(host_env("local"))
    except Exception:
        pass
    try:
        proc = subprocess.Popen(["copilot", "-p", message, "--allow-all-tools"], cwd=cwd, env=env,
                                text=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
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

    threading.Thread(target=finalize, daemon=True).start()
    return session_id, session_id + "/events.jsonl"


def _write_perm_mcp_config():
    """Write (idempotently) the --mcp-config that registers permission_mcp.py as
    an MCP server 'viewerperm'. Additive — the driven claude still loads the
    user's ambient MCP servers (Playwright etc.) since we omit --strict-mcp-config."""
    path = os.path.join(tempfile.gettempdir(), "agents_viewerperm_mcp.json")
    server = str(Path(__file__).parent / "permission_mcp.py")
    cfg = {"mcpServers": {"viewerperm": {"command": sys.executable or "python3",
                                         "args": [server]}}}
    with open(path, "w") as f:
        json.dump(cfg, f)
    return path


def _perm_mcp_config_path(host):
    """--mcp-config path for the viewer permission tool: a local temp file for a
    local run, or a remote path (config + helper shipped over SFTP) for a remote
    host, whose permission_mcp reaches the viewer through an SSH reverse tunnel."""
    if host and host != "local":
        from viewer.remote import remote_setup_perm_mcp
        return remote_setup_perm_mcp(host, PORT)
    return _write_perm_mcp_config()


def _await_question_answer(session_id, tinput, tool_use_id):
    """Block a driven claude's AskUserQuestion until the user answers (or timeout),
    returning the CLI-consumable permission decision. Also persists a durable
    pending_questions row so the app can render the card and it survives restart.
    """
    from viewer import questions
    q_list = questions.questions_from_input(tinput)
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if not job:
            return {"behavior": "deny", "message": "Session ended"}
        pid = secrets.token_hex(8)
        ev = threading.Event()
        job.setdefault("pending_approvals", []).append(
            {"id": pid, "tool_name": "AskUserQuestion", "input": tinput,
             "tool_use_id": tool_use_id, "event": ev, "decision": None,
             "answer": None, "question": True, "created": time.time()})
        cwd = job.get("cwd", "")
        host = job.get("host", "local")
    # Durable row: the app renders the card from this; survives app-close/restart.
    try:
        questions.record(session_id, {"tool_use_id": tool_use_id, "questions": q_list}, host)
    except Exception:
        pass
    # Background push so the user knows a question is waiting (works app-closed).
    try:
        from viewer.push import notify_all
        notify_all(_push_label(session_id, cwd),
                   "Your agent has a question for you.",
                   data={"session": session_id, "host": host, "question": True})
    except Exception:
        pass
    decided = ev.wait(timeout=QUESTION_TIMEOUT)
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        pend = job.get("pending_approvals", []) if job else []
        entry = next((e for e in pend if e["id"] == pid), None)
        if entry:
            pend.remove(entry)
    answer = (entry.get("answer") if entry else None) or ""
    try:
        questions.clear(session_id)  # row consumed; the resumed turn is the record
    except Exception:
        pass
    if not decided or not answer:
        # No answer in time: hand back the CLI's own "unanswered" so it can proceed.
        return {"behavior": "deny", "message": "The user did not answer the questions."}
    return {"behavior": "deny", "message": answer}


def _await_plan_decision(session_id, tinput, tool_use_id):
    """Block a driven claude's ExitPlanMode until the user approves or denies with
    feedback. Persists a durable pending_plans row so the app renders the plan card
    and it survives restart. approve -> allow; deny -> deny+feedback (agent revises)."""
    from viewer import questions
    plan_md = ""
    if isinstance(tinput, dict):
        plan_md = tinput.get("plan") or ""
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if not job:
            return {"behavior": "deny", "message": "Session ended"}
        pid = secrets.token_hex(8)
        ev = threading.Event()
        job.setdefault("pending_approvals", []).append(
            {"id": pid, "tool_name": "ExitPlanMode", "input": tinput,
             "tool_use_id": tool_use_id, "event": ev, "decision": None,
             "feedback": None, "plan": True, "created": time.time()})
        cwd = job.get("cwd", "")
        host = job.get("host", "local")
    try:
        questions.record_plan(session_id, {"tool_use_id": tool_use_id, "plan": plan_md}, host)
    except Exception:
        pass
    try:
        from viewer.push import notify_all
        notify_all(_push_label(session_id, cwd),
                   "Your agent has a plan to review.",
                   data={"session": session_id, "host": host, "plan": True})
    except Exception:
        pass
    decided = ev.wait(timeout=QUESTION_TIMEOUT)
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        pend = job.get("pending_approvals", []) if job else []
        entry = next((e for e in pend if e["id"] == pid), None)
        if entry:
            pend.remove(entry)
    decision = entry.get("decision") if entry else None
    feedback = (entry.get("feedback") if entry else None) or ""
    try:
        questions.clear_plan(session_id)
    except Exception:
        pass
    if not decided:
        return {"behavior": "deny", "message": "No response (timed out) — plan not approved."}
    if decision == "approve":
        return {"behavior": "allow"}
    return {"behavior": "deny",
            "message": feedback or "The user did not approve the plan. Revise and re-present it."}


def register_permission(session_id, token, tool_name, tinput, tool_use_id):
    """Called by permission_mcp.py when a driven claude asks whether a tool may
    run. Registers a pending approval and BLOCKS until the user decides in the UI
    (or PERM_TIMEOUT -> deny). Returns {'behavior': 'allow'|'deny', ...}."""
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if not job or not job.get("perm_token") or job.get("perm_token") != token:
            return {"behavior": "deny", "message": "Unknown or unauthorized session"}
    # AskUserQuestion routes through the permission tool (the CLI's own design:
    # checkPermissions returns behavior:"ask"). We BLOCK here until the user picks
    # an answer, then return {behavior:"deny", message:<answer>} — the shape the CLI
    # consumes as the tool result (verified against the installed CLI, all modes).
    # A durable pending_questions row is also written so the app renders the card
    # and it survives app-close / server restart.
    if tool_name == "AskUserQuestion":
        return _await_question_answer(session_id, tinput, tool_use_id)
    # ExitPlanMode is the CLI's plan-approval gate (also routed through the perm
    # tool, all modes). Block until the user approves or denies-with-feedback:
    #   approve -> {behavior:"allow"}  (clean: the agent starts executing)
    #   deny    -> {behavior:"deny", message:<feedback>}  (agent revises + re-plans)
    if tool_name == "ExitPlanMode":
        return _await_plan_decision(session_id, tinput, tool_use_id)
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if not job:
            return {"behavior": "deny", "message": "Session ended"}
        pid = secrets.token_hex(8)
        ev = threading.Event()
        job.setdefault("pending_approvals", []).append(
            {"id": pid, "tool_name": tool_name, "input": tinput,
             "tool_use_id": tool_use_id, "event": ev, "decision": None,
             "created": time.time()})
        cwd = job.get("cwd", "")
        host = job.get("host", "local")
    # Background push: the run is now blocked waiting on the user (best-effort).
    try:
        from viewer.push import notify_all
        notify_all(_push_label(session_id, cwd),
                   f"Approve {tool_name}? The agent needs your permission to continue.",
                   data={"session": session_id, "host": host, "approval": pid})
    except Exception:
        pass
    decided = ev.wait(timeout=PERM_TIMEOUT)
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        pend = job.get("pending_approvals", []) if job else []
        entry = next((e for e in pend if e["id"] == pid), None)
        if entry:
            pend.remove(entry)
    decision = entry["decision"] if entry else None
    if not decided or decision != "allow":
        return {"behavior": "deny",
                "message": "Denied" if decision == "deny" else "No response (timed out)"}
    return {"behavior": "allow"}


def decide_permission(session_id, pid, decision):
    """UI sets the user's Allow/Deny for a pending tool approval."""
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        entry = next((e for e in job.get("pending_approvals", [])
                      if e["id"] == pid), None) if job else None
        if not entry:
            return False
        entry["decision"] = "allow" if decision == "allow" else "deny"
        entry["event"].set()
        return True


def answer_live_question(session_id, answer):
    """UI answers a live (blocked) AskUserQuestion for a session: set the answer on
    the waiting entry and release its Event so the blocked permission call returns
    the pick to the CLI, continuing the SAME turn. Returns True if a live question
    was waiting, False otherwise (caller falls back to resume)."""
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if not job:
            return False
        entry = next((e for e in job.get("pending_approvals", []) if e.get("question")), None)
        if not entry:
            return False
        entry["answer"] = answer
        entry["event"].set()
        return True


def decide_plan(session_id, decision, feedback=""):
    """UI approves or denies a live (blocked) ExitPlanMode. approve -> the agent
    starts executing; deny -> the agent revises using `feedback`. Returns True if a
    live plan decision was waiting, else False."""
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if not job:
            return False
        entry = next((e for e in job.get("pending_approvals", []) if e.get("plan")), None)
        if not entry:
            return False
        entry["decision"] = "approve" if decision == "approve" else "deny"
        entry["feedback"] = feedback or ""
        entry["event"].set()
        return True


def pending_approvals_public(session_id):
    """Pending Allow/Deny approvals for the UI: id + tool + input (drops the
    internal Event). AskUserQuestion and ExitPlanMode entries are EXCLUDED — they
    surface as their own cards (pending_question / pending_plan), not raw
    Allow/Deny approvals."""
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if not job:
            return []
        return [{"id": e["id"], "tool_name": e["tool_name"], "input": e["input"]}
                for e in job.get("pending_approvals", [])
                if not e.get("question") and not e.get("plan")]


def start_claude_run(session_id, session_args, message, mode, cwd, model="", host="local", provider_env=None):
    """Spawn a headless claude run (stream-json, stdin kept open) and track it
    in CHAT_JOBS. While it runs, messages can be QUEUED (delivered as the next
    turn on the same process) or STEERED (injected mid-turn, like the TUI).
    host != 'local' runs claude on that SSH host instead.

    provider_env (Agent mode): an optional {ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_MODEL} dict that points the harness at a custom Anthropic-compatible
    endpoint (our llama-server). None = the normal Anthropic-cloud Claude run,
    byte-identical to before.
    Returns False if the session already has a running job."""
    remote = bool(host) and host != "local"
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if job and job["running"]:
            return False
        job = {"running": True, "returncode": None, "stderr": "", "stdout": "",
               "started": time.time(), "message": message,
               "queue": [], "proc": None, "turns": 0, "steered": 0,
               "stdin_open": False, "mode": mode, "model": model, "cwd": cwd,
               "interrupted": False, "host": host,
               "pending_approvals": [], "perm_token": ""}
        CHAT_JOBS[session_id] = job

    binary = "claude" if remote else claude_bin()
    cmd = [binary, "-p", "--input-format", "stream-json",
           "--output-format", "stream-json", "--verbose"] + session_args
    if mode in ("bypass", "bypassPermissions"):
        cmd.append("--dangerously-skip-permissions")
    elif mode in ("acceptEdits", "plan"):
        cmd += ["--permission-mode", mode]
    elif mode == "default":
        cmd += ["--permission-mode", "default"]
    # Always attach the viewer permission tool. In "default" mode it gates each
    # tool call (Allow/Deny); in every mode it is ALSO how AskUserQuestion reaches
    # the user (the CLI routes AUQ's checkPermissions "ask" to this tool, even under
    # --dangerously-skip-permissions — verified). Remote hosts reach the viewer via
    # an SSH reverse tunnel set up below; the MCP config + helper run on the host.
    perm_token = secrets.token_hex(16)
    job["perm_token"] = perm_token
    cmd += ["--mcp-config", _perm_mcp_config_path(host),
            "--permission-prompt-tool", "mcp__viewerperm__approve"]
    # "default" is the composer's sentinel for "no --model" (the CLI picks). Some
    # clients persist it as a literal, which would run `claude --model default`
    # (an invalid model id). Treat it — and blank — as "omit --model".
    if model and model != "default" and re.fullmatch(r"[A-Za-z0-9._-]+", model):
        cmd += ["--model", model]

    # Custom-provider agent mode: point the harness at the preset's endpoint. The
    # claude CLI reads env from ~/.claude/settings.json and that WINS over the
    # subprocess environment — so injecting ANTHROPIC_* into env alone is silently
    # overridden by any base URL pinned in settings.json (e.g. a LiteLLM proxy).
    # A `--settings <file>` with the endpoint in its `env` DOES take precedence
    # (verified: it forces /v1/messages to the given base URL). We write a temp
    # settings file and pass it, so the session's provider actually routes to its
    # model (e.g. Qwen on :8081) instead of leaking to the global default.
    provider_settings_path = None
    if provider_env:
        try:
            import tempfile
            penv = {k: str(v) for k, v in provider_env.items()}
            # Clear any inherited small-fast model so background calls don't leak to
            # a different endpoint's model namespace.
            penv.setdefault("ANTHROPIC_SMALL_FAST_MODEL", penv.get("ANTHROPIC_MODEL", ""))
            fd, provider_settings_path = tempfile.mkstemp(prefix="viewer-prov-", suffix=".json")
            with os.fdopen(fd, "w") as f:
                json.dump({"env": penv}, f)
            os.chmod(provider_settings_path, 0o600)
            cmd += ["--settings", provider_settings_path]
        except Exception as e:
            print(f"[engine] provider settings write failed: {e}", flush=True)

    # Per-session system prompt and goal, managed from the viewer's panel.
    meta = SESSION_META.get(session_id) or {}
    extra = []
    if meta.get("systemPrompt"):
        extra.append(meta["systemPrompt"])
    if meta.get("goal"):
        extra.append("Active goal (keep working toward this; check it before stopping): " + meta["goal"])
    if extra:
        cmd += ["--append-system-prompt", "\n\n".join(extra)]

    def run():
        proc = None
        stderr_buf = []
        try:
            env = dict(os.environ)
            env["PATH"] = f"{Path.home()}/.local/bin:" + env.get("PATH", "")
            if perm_token:  # let permission_mcp.py reach the viewer + this session
                env["VIEWER_PERM_SESSION"] = session_id
                env["VIEWER_PERM_PORT"] = str(PORT)
                env["VIEWER_PERM_TOKEN"] = perm_token
            # Fall back to a setup-token captured by the viewer's login flow
            # when no regular OAuth credentials exist.
            if not env.get("CLAUDE_CODE_OAUTH_TOKEN") and VIEWER_TOKEN_FILE.exists():
                if auth_status().get("method") == "setup-token":
                    try:
                        env["CLAUDE_CODE_OAUTH_TOKEN"] = VIEWER_TOKEN_FILE.read_text().strip()
                    except Exception:
                        pass
            try:  # per-host env vars (e.g. GH_TOKEN) so git push / gh authenticate
                from viewer.hostenv import host_env
                env.update(host_env(host))
            except Exception:
                pass
            # Agent mode: point the harness at a custom Anthropic-compatible endpoint
            # (our llama-server). Applied LAST so it wins over any inherited creds.
            if provider_env:
                env.update({str(k): str(v) for k, v in provider_env.items()})
            # If Playwright MCP on this host attaches to our CDP browser, it
            # must be running before claude boots (no-op / ~50ms otherwise).
            ensure_mcp_browser(host if remote else "local")
            if remote:
                # nvm/npm installs aren't on the non-interactive login PATH;
                # resolve the actual binary location on the host first.
                try:
                    cmd[0] = remote_claude_bin(host)
                except Exception:
                    pass
                # Ship the perm-tool env into the remote shell so its permission_mcp
                # can reach the viewer directly at its tailnet address.
                rperm_env = None
                if perm_token:
                    from viewer.remote import viewer_tailnet_base
                    base = viewer_tailnet_base(PORT)
                    rperm_env = {"VIEWER_PERM_SESSION": session_id,
                                 "VIEWER_PERM_TOKEN": perm_token}
                    if base:
                        rperm_env["VIEWER_PERM_BASE"] = base
                proc = RemoteProc(host, cmd, cwd, env=rperm_env)
            else:
                proc = subprocess.Popen(cmd, cwd=cwd, env=env, text=True,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE)
            with CHAT_LOCK:
                job["proc"] = proc
                job["stdin_open"] = True
            # Remote (paramiko) stderr reads as bytes; local (text=True) as str.
            def _drain_stderr():
                data = proc.stderr.read()
                stderr_buf.append(data.decode("utf-8", "replace") if isinstance(data, bytes) else data)
            threading.Thread(target=_drain_stderr, daemon=True).start()
            stream_user_message(proc, message)

            deadline = time.time() + CHAT_TIMEOUT
            for line in proc.stdout:
                if time.time() > deadline:
                    raise TimeoutError(f"Timed out after {CHAT_TIMEOUT}s")
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if ev.get("type") != "result":
                    continue
                job["turns"] += 1
                # Capture the final assistant text so the push notification can
                # show the actual reply, not a generic "finished" message.
                res_text = ev.get("result") or ev.get("subtype") or ""
                if isinstance(res_text, str) and res_text.strip():
                    job["last_result"] = res_text.strip()
                # Turn finished: feed the next queued message, or shut down.
                with CHAT_LOCK:
                    nxt = job["queue"].pop(0) if job["queue"] else None
                    if nxt is None:
                        job["stdin_open"] = False
                if nxt is not None:
                    stream_user_message(proc, nxt)
                else:
                    try:
                        proc.stdin.close()
                    except OSError:
                        pass
            proc.wait(timeout=60)
            job["returncode"] = proc.returncode
        except Exception as e:
            job["returncode"] = -1
            job["stderr"] = str(e)[:500]
            if proc:
                try:
                    proc.kill()
                except OSError:
                    pass
        finally:
            # Must never raise: the running/queue cleanup below has to run so the
            # session doesn't stay wedged as "busy" after the process exits.
            try:
                if stderr_buf and stderr_buf[0]:
                    tail = stderr_buf[0]
                    if isinstance(tail, bytes):
                        tail = tail.decode("utf-8", "replace")
                    job["stderr"] = (job["stderr"] + "\n" + tail)[-4000:].strip()
            except Exception:
                pass
            with CHAT_LOCK:
                leftovers = list(job["queue"])
                job["queue"] = []
                job["proc"] = None
                job["stdin_open"] = False
                job["running"] = False
                job["finished"] = time.time()
                rc = job.get("returncode")
                interrupted = job.get("interrupted")
                last_result = job.get("last_result", "")
            # Messages queued in the closing race get a fresh resumed run.
            if leftovers and job["returncode"] == 0:
                first, rest = leftovers[0], leftovers[1:]
                if start_claude_run(session_id, ["--resume", session_id], first,
                                    job["mode"], job["cwd"], job["model"], job.get("host", "local")):
                    with CHAT_LOCK:
                        CHAT_JOBS[session_id]["queue"].extend(rest)
                    leftovers = []  # a follow-up run is now carrying them; don't also notify
            # (AskUserQuestion is handled synchronously by the permission tool while
            # the turn is live — see _await_question_answer — so there is nothing to
            # detect here at run-finish.)
            # Background push: tell the app the turn finished (best-effort, async).
            # Skip when a follow-up resumed run is still carrying queued work, and
            # when the user interrupted (they're already looking).
            if not leftovers and not interrupted:
                try:
                    from viewer.push import notify_all, push_preview
                    label = _push_label(session_id, cwd)
                    phost = job.get("host", "local")
                    if rc == 0 and last_result:
                        body = push_preview(last_result)
                        notify_all(label, body, data={"session": session_id, "host": phost})
                    else:
                        body = "Your agent finished a turn." if rc == 0 else "The run ended with an error."
                        notify_all(label, body, data={"session": session_id, "host": phost})
                except Exception:
                    pass

    threading.Thread(target=run, daemon=True).start()
    return True


def interrupt_chat(session_id):
    """Abort the running turn (Esc in the TUI): SIGINT, escalating if needed.
    Queued messages are dropped — an interrupt means 'stop what's planned'."""
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if not job or not job["running"]:
            return False
        proc = job.get("proc")
        job["interrupted"] = True
        job["queue"] = []
        job["stdin_open"] = False
    if proc:
        try:
            proc.send_signal(signal.SIGINT)
        except OSError:
            pass

        def escalate(sig_fn):
            try:
                if proc.poll() is None:
                    sig_fn()
            except OSError:
                pass
        threading.Timer(4.0, lambda: escalate(proc.terminate)).start()
        threading.Timer(8.0, lambda: escalate(proc.kill)).start()
    return True


def enqueue_chat(session_id, text):
    """Add a message to a running job's queue. Returns queue position or None."""
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if not job or not job["running"]:
            return None
        job["queue"].append(text)
        return len(job["queue"])


def steer_chat(session_id, text):
    """Inject a message into the running turn (CLI steering). Returns
    'steered', 'queued' (fell back — stdin already closing), or None."""
    with CHAT_LOCK:
        job = CHAT_JOBS.get(session_id)
        if not job or not job["running"]:
            return None
        proc = job.get("proc")
        if proc and job.get("stdin_open"):
            try:
                stream_user_message(proc, text)
                job["steered"] += 1
                return "steered"
            except (OSError, ValueError):
                job["stdin_open"] = False
        job["queue"].append(text)
        return "queued"


def run_loop_iteration(session_id, rel_path, prompt, model=""):
    """Fire one loop run against a session (used by the scheduler)."""
    full = CLAUDE_DIR.parent / rel_path
    if not full.exists():
        return
    cwd = extract_cwd(full)
    if not os.path.isdir(cwd):
        cwd = str(Path.home())
    start_claude_run(session_id, ["--resume", session_id], prompt, "acceptEdits", cwd, model)


def extract_cwd(session_file):
    """Find the working directory recorded in the session."""
    try:
        with open(session_file, "r") as f:
            for i, line in enumerate(f):
                if i > 100:
                    break
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("cwd"):
                    return obj["cwd"]
    except Exception:
        pass
    return str(Path.home())


def compute_session_summary(line_iter, cwd):
    """Full-session stats from a JSONL line iterator (local file or remote
    contents). Shared by local and remote summary paths so both produce
    identical output."""
    data = {"lines": 0, "userMessages": 0, "assistantMessages": 0, "totalInput": 0,
            "totalOutput": 0, "tools": {}, "models": [], "title": "", "summaries": [],
            "startTime": None, "endTime": None, "cwd": cwd}
    models = set()
    first_ts = last_ts = None
    timeline = []
    for line in line_iter:
        data["lines"] += 1
        try:
            obj = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        t = obj.get("type")
        ts = obj.get("timestamp")
        if ts:
            if not first_ts or ts < first_ts:
                first_ts = ts
            if not last_ts or ts > last_ts:
                last_ts = ts
        if t == "custom-title" and obj.get("customTitle"):
            data["title"] = obj["customTitle"]
        elif t == "summary" and obj.get("summary"):
            if obj["summary"] not in data["summaries"]:
                data["summaries"].append(obj["summary"])
        elif t == "user" and not obj.get("isMeta"):
            c = (obj.get("message") or {}).get("content")
            if not (isinstance(c, list) and all(isinstance(b, dict) and b.get("type") == "tool_result" for b in c)):
                data["userMessages"] += 1
        elif t == "assistant":
            data["assistantMessages"] += 1
            m = obj.get("message") or {}
            if m.get("model") and m["model"] != "<synthetic>":
                models.add(m["model"])
            u = m.get("usage") or {}
            ti = u.get("input_tokens", 0) or 0
            to = u.get("output_tokens", 0) or 0
            data["totalInput"] += ti
            data["totalOutput"] += to
            if u:
                timeline.append((ti, to))
            for b_ in (m.get("content") or []):
                if isinstance(b_, dict) and b_.get("type") == "tool_use":
                    data["tools"][b_.get("name", "?")] = data["tools"].get(b_.get("name", "?"), 0) + 1
    data["models"] = sorted(models)
    data["startTime"] = first_ts
    data["endTime"] = last_ts
    data["summaries"] = data["summaries"][-5:]
    # Downsample the full-session token timeline to <=240 buckets.
    if timeline:
        bucket_n = min(len(timeline), 240)
        per = max(1, -(-len(timeline) // bucket_n))
        data["tokenTimeline"] = [
            {"input": sum(t[0] for t in timeline[i:i + per]),
             "output": sum(t[1] for t in timeline[i:i + per])}
            for i in range(0, len(timeline), per)]
    else:
        data["tokenTimeline"] = []
    return data


def remote_session_summary(hid, rel):
    """Full-session stats for a remote session, computed ON the host via
    remote_run_python. Never pull the file over SFTP for this: a 25 MB session
    means minutes of 32 KB round-trips while holding the host op-lock, which
    starves every other request for that host ("host connection is busy").
    The host runs the same compute_session_summary source (inspect.getsource),
    so local and remote output cannot drift. Cached by (mtime, size)."""
    full = remote_full_path(hid, rel)
    if not full:
        return None
    with SSH.lock_for(hid):
        c = SSH.get(hid)
        home = c["home"]
        try:
            st = c["sftp"].stat(full)
        except IOError:
            return None
    key = (hid, full)
    hit = REMOTE_SUMMARY_CACHE.get(key, st.st_mtime, st.st_size)
    if hit is not None:
        return hit
    import inspect
    script = ("import json, sys\n"
              + inspect.getsource(compute_session_summary)
              + "P = json.loads(%r)\n" % json.dumps({"path": full, "home": home})
              + r"""
try:
    with open(P["path"], errors="replace") as fh:
        lines = fh.read().splitlines()
except OSError:
    print("null"); sys.exit()
cwd = P["home"]
for line in lines[:200]:
    try:
        o = json.loads(line)
    except Exception:
        continue
    if o.get("cwd"):
        cwd = o["cwd"]; break
print(json.dumps(compute_session_summary(lines, cwd)))
""")
    txt = remote_run_python(hid, script)
    try:
        data = json.loads(txt.strip().splitlines()[-1])
    except Exception:
        return None
    if data:
        REMOTE_SUMMARY_CACHE.put(key, st.st_mtime, st.st_size, data)
    return data


class StatCache:
    """Cache keyed on an opaque key, invalidated when the source file's
    (mtime, size) change. FIFO-capped at `cap` entries. Replaces three
    hand-rolled dicts that all did this identically."""
    def __init__(self, cap=50):
        self._d = {}
        self._cap = cap

    def get(self, key, mtime, size):
        c = self._d.get(key)
        if c is not None and c["mtime"] == mtime and c["size"] == size:
            return c["data"]
        return None

    def put(self, key, mtime, size, data):
        self._d[key] = {"mtime": mtime, "size": size, "data": data}
        if len(self._d) > self._cap:
            self._d.pop(next(iter(self._d)))


REMOTE_SUMMARY_CACHE = StatCache()   # (hid, path) invalidated by (mtime, size)


# ===== Session analysis: assumptions + human decisions (LLM, on demand) =====

def session_digest_from_lines(lines, max_chars=55000):
    """Compact USER/CLAUDE transcript for the analyzer — user messages in full
    (they carry the human decisions), assistant TEXT truncated, tool noise
    dropped. Oldest turns trimmed if over the cap."""
    import json as _json
    parts = []
    for line in lines:
        try:
            o = _json.loads(line)
        except Exception:
            continue
        t = o.get("type")
        if t == "user" and not o.get("isMeta"):
            c = (o.get("message") or {}).get("content")
            if isinstance(c, list):
                if all(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
                    continue
                txt = " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
            else:
                txt = c if isinstance(c, str) else ""
            txt = (txt or "").strip()
            if txt:
                parts.append("USER: " + txt[:1500])
        elif t == "assistant":
            c = (o.get("message") or {}).get("content") or []
            txt = " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text").strip()
            if txt:
                parts.append("CLAUDE: " + txt[:700])
    digest = "\n".join(parts)
    if len(digest) > max_chars:
        digest = "[…earlier turns omitted…]\n" + digest[-max_chars:]
    return digest


ANALYSIS_PROMPT = (
    "You are reviewing a Claude Code coding session between a USER and CLAUDE (the AI assistant). "
    "From the transcript, extract exactly two lists:\n"
    "1. \"assumptions\": specific assumptions or defaults CLAUDE made WITHOUT the user explicitly "
    "confirming them — interpretations of ambiguous requests, technical choices made unilaterally, "
    "defaults picked, things taken for granted.\n"
    "2. \"decisions\": explicit decisions, directions, corrections, approvals, or rejections the USER "
    "made — what the human actually chose or steered.\n"
    "Each item is ONE concise line (≤16 words), concrete and specific to THIS session (not generic). "
    "Most important first, at most 12 per list. Output ONLY minified JSON of the form "
    "{\"assumptions\":[...],\"decisions\":[...]} with no prose and no markdown fences.\n\nTRANSCRIPT:\n")


def _claude_run_env():
    env = dict(os.environ)
    env["PATH"] = f"{Path.home()}/.local/bin:" + env.get("PATH", "")
    if not env.get("CLAUDE_CODE_OAUTH_TOKEN") and VIEWER_TOKEN_FILE.exists():
        if auth_status().get("method") == "setup-token":
            try:
                env["CLAUDE_CODE_OAUTH_TOKEN"] = VIEWER_TOKEN_FILE.read_text().strip()
            except Exception:
                pass
    return env


def run_claude_analysis(digest, model="haiku", timeout=150):
    """One-shot claude -p over the digest → {"assumptions":[], "decisions":[]}."""
    if not digest.strip():
        return {"assumptions": [], "decisions": []}
    cmd = [claude_bin(), "-p", ANALYSIS_PROMPT + digest,
           "--output-format", "json", "--model", model]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                       env=_claude_run_env(), cwd=str(Path.home()))
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or "claude failed")[-400:])
    text = (json.loads(p.stdout).get("result") or "").strip()
    m = re.search(r"\{.*\}", text, re.S)          # strip any prose/fences around the JSON
    data = json.loads(m.group(0) if m else text)
    clean = lambda arr: [str(x).strip() for x in (arr or []) if str(x).strip()][:12]
    return {"assumptions": clean(data.get("assumptions")), "decisions": clean(data.get("decisions"))}


ANALYSIS_CACHE = StatCache()   # (hid, path) invalidated by (mtime, size)


def _remote_digest(hid, full):
    """Build the digest ON the host (like remote_session_summary) so a 300MB
    transcript isn't dragged over SFTP — only the compact digest crosses."""
    import inspect
    script = ("import json, sys\n"
              + inspect.getsource(session_digest_from_lines)
              + "P = json.loads(%r)\n" % json.dumps({"path": full})
              + "try:\n"
                "    lines = open(P['path'], errors='replace').read().splitlines()\n"
                "except OSError:\n"
                "    print('null'); sys.exit()\n"
                "print(json.dumps(session_digest_from_lines(lines)))\n")
    out = remote_run_python(hid, script)
    try:
        return json.loads(out.strip().splitlines()[-1]) or ""
    except Exception:
        return ""


def session_analysis(hid, rel, refresh=False):
    """(assumptions, decisions) for a session, cached by (mtime,size)."""
    if hid == "local":
        full = (CLAUDE_DIR.parent / rel).resolve()
        if not str(full).startswith(str(CLAUDE_DIR.parent.resolve()) + os.sep) or not full.exists():
            return None
        st = full.stat()
        key = (hid, str(full))
        if not refresh:
            hit = ANALYSIS_CACHE.get(key, st.st_mtime, st.st_size)
            if hit is not None:
                return hit
        with open(full, errors="replace") as fh:
            digest = session_digest_from_lines(fh.read().splitlines())
    else:
        full = remote_full_path(hid, rel)
        if not full:
            return None
        with SSH.lock_for(hid):
            c = SSH.get(hid)
            try:
                st = c["sftp"].stat(full)
            except IOError:
                return None
        key = (hid, full)
        if not refresh:
            hit = ANALYSIS_CACHE.get(key, st.st_mtime, st.st_size)
            if hit is not None:
                return hit
        digest = _remote_digest(hid, full)
        if not digest:
            return None
    data = run_claude_analysis(digest)
    ANALYSIS_CACHE.put(key, st.st_mtime, st.st_size, data)
    return data


# ===== Host: the local-vs-remote seam =====
#
# One interface over "where the session files and shell live." Every filesystem
# / session / config query goes through it, so a feature can't silently target
# the LOCAL box when a remote host is selected — the recurring bug class this
# project kept hitting. LocalHost holds the logic that used to be inline in the
# route handlers; RemoteHost delegates to the proven remote_* helpers over SSH.
# Handlers do `host = get_host(hid); host.<method>()` — no `if hid == "local"`.

class Host:
    """Interface (documented via LocalHost/RemoteHost). Methods return plain
    data or raise; the HTTP layer turns that into a response."""
    hid = "local"
    is_local = True

    def fs_list(self, raw, hidden): raise NotImplementedError
    def projects(self): raise NotImplementedError
    def capabilities(self, cwd): raise NotImplementedError
    def extract_cwd(self, rel): raise NotImplementedError
    def session_summary(self, rel): raise NotImplementedError
    def analysis(self, rel, refresh=False): return session_analysis(self.hid, rel, refresh)
    def resolve(self, sid): raise NotImplementedError
    def list_sessions(self): raise NotImplementedError
    def mcp_save(self, name, scope, cfg, cwd, delete): raise NotImplementedError


class LocalHost(Host):
    hid = "local"
    is_local = True

    def fs_list(self, raw, hidden):
        p = Path(os.path.expanduser(raw)).resolve()
        if not p.is_dir():
            return {"error": "Not a directory", "status": 404}
        entries, truncated = [], False
        try:
            for child in p.iterdir():
                name = child.name
                if not hidden and name.startswith("."):
                    continue
                try:
                    st = child.stat()
                    entries.append({"name": name, "dir": child.is_dir(),
                                    "size": 0 if child.is_dir() else st.st_size, "mtime": st.st_mtime})
                except OSError:
                    continue
                if len(entries) >= 800:
                    truncated = True
                    break
        except PermissionError:
            return {"error": "Permission denied", "status": 403}
        return {"path": str(p), "parent": str(p.parent) if p != Path(p.anchor) else None,
                "entries": entries, "home": str(Path.home()), "truncated": truncated}

    def projects(self):
        dirs = {}
        for proj_dir in CLAUDE_DIR.iterdir() if CLAUDE_DIR.is_dir() else []:
            if not proj_dir.is_dir():
                continue
            files = [f for f in proj_dir.glob("*.jsonl")]
            if not files:
                continue
            newest = max(files, key=lambda f: f.stat().st_mtime)
            cwd = extract_cwd(newest)
            if cwd and os.path.isdir(cwd):
                mtime = newest.stat().st_mtime
                if cwd not in dirs or mtime > dirs[cwd]:
                    dirs[cwd] = mtime
        return [{"cwd": c, "modified": m} for c, m in sorted(dirs.items(), key=lambda kv: kv[1], reverse=True)]

    def capabilities(self, cwd):
        cwd = Path(cwd) if cwd else None
        skills, seen = [], set()

        def add_skill(md_path, source, editable):
            name = md_path.parent.name
            key = f"{source}:{name}"
            if key in seen:
                return
            seen.add(key)
            skills.append({"name": name, "description": frontmatter_description(md_path),
                           "source": source, "path": str(md_path), "editable": editable})

        if cwd:
            for f in sorted((cwd / ".claude" / "skills").glob("*/SKILL.md")):
                add_skill(f, "project", True)
        for f in sorted((Path.home() / ".claude" / "skills").glob("*/SKILL.md")):
            add_skill(f, "user", True)
        plugins_root = Path.home() / ".claude" / "plugins" / "cache"
        if plugins_root.is_dir():
            for f in sorted(plugins_root.glob("*/*/*/skills/*/SKILL.md")):
                add_skill(f, f"plugin:{f.parents[2].parent.name}", False)

        mcp = []

        def add_mcp(name, cfg, scope, editable):
            if not isinstance(cfg, dict):
                return
            transport = cfg.get("type") or ("http" if cfg.get("url") else "stdio")
            target = cfg.get("url") or " ".join([cfg.get("command", "")] + list(cfg.get("args", [])))
            mcp.append({"name": name, "scope": scope, "transport": transport,
                        "target": target.strip(), "config": cfg, "editable": editable})

        try:
            cj = json.loads((Path.home() / ".claude.json").read_text())
        except Exception:
            cj = {}
        for name, cfg in (cj.get("mcpServers") or {}).items():
            add_mcp(name, cfg, "global", True)
        if cwd:
            for name, cfg in (((cj.get("projects") or {}).get(str(cwd)) or {}).get("mcpServers") or {}).items():
                add_mcp(name, cfg, "project-global", False)
            try:
                pm = json.loads((cwd / ".mcp.json").read_text())
                for name, cfg in (pm.get("mcpServers") or {}).items():
                    add_mcp(name, cfg, "project", True)
            except Exception:
                pass
        if plugins_root.is_dir():
            for pm_file in plugins_root.glob("*/*/*/.mcp.json"):
                try:
                    pd = json.loads(pm_file.read_text())
                except Exception:
                    continue
                for name, cfg in (pd.get("mcpServers") or {}).items():
                    add_mcp(name, cfg, f"plugin:{pm_file.parents[1].name}", False)
        return {"skills": skills, "mcp": mcp}

    def _resolve_full(self, rel):
        try:
            full = (CLAUDE_DIR.parent / rel).resolve()
            if not str(full).startswith(str(CLAUDE_DIR.parent.resolve()) + os.sep):
                return None
            return full if full.exists() else None
        except Exception:
            return None

    def extract_cwd(self, rel):
        full = self._resolve_full(rel)
        return extract_cwd(full) if full else ""

    def session_summary(self, rel):
        full = self._resolve_full(rel)
        if not full:
            return None
        st = full.stat()
        key = ("local", str(full))
        hit = LOCAL_SUMMARY_CACHE.get(key, st.st_mtime, st.st_size)
        if hit is not None:
            return hit
        with open(full, "r", errors="replace") as f:
            data = compute_session_summary(f, extract_cwd(full))
        LOCAL_SUMMARY_CACHE.put(key, st.st_mtime, st.st_size, data)
        return data

    def resolve(self, sid):
        matches = list(CLAUDE_DIR.glob(f"*/{sid}.jsonl"))
        if matches:
            return {"found": True, "path": str(matches[0].relative_to(CLAUDE_DIR.parent))}
        return {"found": False}

    @staticmethod
    def _preview_from(obj):
        """Chat-list preview from one transcript record: 'You: …' for user text,
        plain text for assistant. Returns None for records that aren't visible
        messages (tool results, meta records, <command…> wrappers)."""
        t = obj.get("type")
        if t not in ("user", "assistant") or obj.get("isMeta"):
            return None
        content = (obj.get("message") or {}).get("content")
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            text = "\n".join(b.get("text", "") for b in content
                             if isinstance(b, dict) and b.get("type") == "text")
        else:
            return None
        text = text.strip()
        if not text or text.startswith("<"):   # command/task-notification wrappers
            return None
        text = " ".join(text.split())[:140]
        return ("You: " + text) if t == "user" else text

    def list_sessions(self):
        sessions = []
        for jsonl_file in CLAUDE_DIR.rglob("*.jsonl"):
            if "subagents" in str(jsonl_file):
                continue
            stat = jsonl_file.stat()
            title, session_id, preview = "", jsonl_file.stem, ""
            try:
                if stat.st_size > 50000:
                    # The tail scan already runs for titles — the last-message
                    # preview rides along in the same pass at no extra I/O.
                    with open(jsonl_file, "r") as f:
                        f.seek(max(0, stat.st_size - 50000)); f.readline()
                        for line in f:
                            try:
                                obj = json.loads(line)
                            except json.JSONDecodeError:
                                continue
                            if obj.get("type") == "custom-title":
                                title = obj.get("customTitle", "")
                            if obj.get("type") == "agent-name" and not title:
                                title = obj.get("agentName", "")
                            p = self._preview_from(obj)
                            if p:
                                preview = p
                if not title or not preview:
                    with open(jsonl_file, "r") as f:
                        for i, line in enumerate(f):
                            if i > 200:
                                break
                            try:
                                obj = json.loads(line)
                            except json.JSONDecodeError:
                                continue
                            if obj.get("type") == "custom-title" and not title:
                                title = obj.get("customTitle", "")
                            if obj.get("type") == "agent-name" and not title:
                                title = obj.get("agentName", "")
                            p = self._preview_from(obj)
                            if p:
                                preview = p
            except Exception:
                pass
            pdir = str(jsonl_file.parent.name)
            if pdir.startswith(_HOME_ENC + "-"):
                pdir = "~/" + pdir[len(_HOME_ENC) + 1:]
            project = pdir.replace("--", "/").replace("-", "/")
            sessions.append({"id": session_id, "path": str(jsonl_file.relative_to(CLAUDE_DIR.parent)),
                             "title": title or session_id[:8], "project": project,
                             "size": stat.st_size, "modified": stat.st_mtime,
                             "preview": preview})
        sessions.sort(key=lambda s: s["modified"], reverse=True)
        return sessions

    def mcp_save(self, name, scope, cfg, cwd, delete):
        if scope == "global":
            path = Path.home() / ".claude.json"
            try:
                data = json.loads(path.read_text())
            except Exception as e:
                return {"error": f"Cannot read ~/.claude.json: {e}", "status": 500}
            shutil.copy2(path, str(path) + ".bak-viewer")
        elif scope == "project":
            if not cwd:
                return {"error": "Session not found for project scope", "status": 404}
            path = Path(cwd) / ".mcp.json"
            try:
                data = json.loads(path.read_text()) if path.exists() else {}
            except Exception:
                data = {}
            if path.exists():
                shutil.copy2(path, str(path) + ".bak-viewer")
        else:
            return {"error": "Scope must be global or project", "status": 400}
        servers = data.setdefault("mcpServers", {})
        if delete:
            if servers.pop(name, None) is None:
                return {"error": "Server not found in that scope", "status": 404}
        else:
            servers[name] = cfg
        try:
            path.write_text(json.dumps(data, indent=2))
        except Exception as e:
            return {"error": str(e), "status": 500}
        return {"saved": True, "file": str(path)}


class RemoteHost(Host):
    def __init__(self, hid):
        self.hid = hid
        self.is_local = False

    def fs_list(self, raw, hidden):        return remote_fs(self.hid, raw, hidden)
    def projects(self):                    return remote_projects(self.hid)
    def capabilities(self, cwd):           return remote_capabilities(self.hid, cwd)
    def extract_cwd(self, rel):            return remote_extract_cwd(self.hid, rel)
    def session_summary(self, rel):        return remote_session_summary(self.hid, rel)
    def list_sessions(self):               return remote_list_sessions(self.hid)
    def mcp_save(self, name, scope, cfg, cwd, delete):
        return remote_mcp_save(self.hid, name, scope, cfg, cwd, delete)

    def resolve(self, sid):
        return remote_resolve(self.hid, sid)


LOCAL_SUMMARY_CACHE = StatCache()     # (host, path) invalidated by (mtime, size)
_HOSTS = {}


def get_host(hid):
    """Host instance for hid — 'local' or an SSH host id. Cached (stateless)."""
    if not hid or hid == "local":
        hid = "local"
    h = _HOSTS.get(hid)
    if h is None:
        h = LocalHost() if hid == "local" else RemoteHost(hid)
        _HOSTS[hid] = h
    return h
