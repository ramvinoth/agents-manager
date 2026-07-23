"""viewer.codex — Codex-specific session operations (capabilities, MCP config,
fork / restore / new-session). Local-only. Every entry point here is only ever
reached when agent == "codex"; the Claude and Pi flows never call into this
module, so they stay byte-for-byte unchanged.

Codex stores rollouts as ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
(lines {timestamp,type,payload}); the transcript uuid the frontend sends for
fork/restore is md5(raw line) via adapters._uuid, so we match cut points by
re-hashing the raw lines. MCP config is TOML at ~/.codex/config.toml; skills are
SKILL.md files under ~/.codex/skills (.system/* are read-only)."""
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid as uuid_mod
from pathlib import Path

from viewer.config import CHAT_JOBS, CHAT_LOCK, CHAT_TIMEOUT
from viewer.adapters import _uuid, resolve_agent_session
from viewer.engine import codex_session_meta, frontmatter_description
from viewer.login import codex_bin

CODEX_HOME = Path.home() / ".codex"
CODEX_SESSIONS = CODEX_HOME / "sessions"
CODEX_CONFIG = CODEX_HOME / "config.toml"
CODEX_SKILLS = CODEX_HOME / "skills"


# ---- capabilities (skills + MCP) ------------------------------------------
def codex_capabilities(cwd=""):
    """Skills + MCP servers for Codex, in the same shape as LocalHost.capabilities
    so the existing RHS panel renders unchanged."""
    skills, seen = [], set()

    def add_skill(md_path, source, editable):
        name = md_path.parent.name
        key = f"{source}:{name}"
        if key in seen:
            return
        seen.add(key)
        skills.append({"name": name, "description": frontmatter_description(md_path),
                       "source": source, "path": str(md_path), "editable": editable})

    cwd_path = Path(cwd) if cwd else None
    if cwd_path:
        for f in sorted((cwd_path / ".codex" / "skills").glob("*/SKILL.md")):
            add_skill(f, "project", True)
    if CODEX_SKILLS.is_dir():
        for f in sorted(CODEX_SKILLS.glob("*/SKILL.md")):       # user skills
            add_skill(f, "user", True)
        for f in sorted(CODEX_SKILLS.glob(".system/*/SKILL.md")):  # built-in, read-only
            add_skill(f, "system", False)

    mcp = []
    for name, cfg in (_codex_config().get("mcp_servers") or {}).items():
        if not isinstance(cfg, dict):
            continue
        transport = cfg.get("type") or ("http" if cfg.get("url") else "stdio")
        target = cfg.get("url") or " ".join([cfg.get("command", "")] + list(cfg.get("args", [])))
        mcp.append({"name": name, "scope": "global", "transport": transport,
                    "target": target.strip(), "config": cfg, "editable": True})
    return {"skills": skills, "mcp": mcp}


# ---- MCP config (TOML) -----------------------------------------------------
def _codex_config():
    import tomllib
    try:
        return tomllib.loads(CODEX_CONFIG.read_text()) if CODEX_CONFIG.exists() else {}
    except Exception:
        return {}


def codex_mcp_save(name, cfg, delete=False):
    """Add/replace or delete an MCP server in ~/.codex/config.toml (backup first)."""
    import tomli_w
    data = _codex_config()
    servers = data.setdefault("mcp_servers", {})
    if delete:
        if name not in servers:
            return {"error": "Server not found in Codex config", "status": 404}
        servers.pop(name, None)
    else:
        if not isinstance(cfg, dict):
            return {"error": "config must be a JSON object", "status": 400}
        servers[name] = cfg
    try:
        if CODEX_CONFIG.exists():
            shutil.copy2(CODEX_CONFIG, str(CODEX_CONFIG) + ".bak-viewer")
        CODEX_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        CODEX_CONFIG.write_text(tomli_w.dumps(data))
    except Exception as e:
        return {"error": str(e), "status": 500}
    return {"deleted": True} if delete else {"saved": True}


# ---- skills (user scope, editable) ----------------------------------------
def codex_skill_save(name, content):
    if not re.fullmatch(r"[\w-]+", name or ""):
        return {"error": "Skill name must be letters/digits/dashes/underscores", "status": 400}
    d = CODEX_SKILLS / name
    try:
        d.mkdir(parents=True, exist_ok=True)
        (d / "SKILL.md").write_text(content or "")
    except Exception as e:
        return {"error": str(e), "status": 500}
    return {"saved": True, "path": str(d / "SKILL.md")}


def codex_skill_delete(path):
    try:
        p = Path(path).resolve()
    except Exception:
        return {"error": "Bad path", "status": 400}
    root = CODEX_SKILLS.resolve()
    if not str(p).startswith(str(root) + os.sep) or p.name != "SKILL.md" or not p.exists():
        return {"error": "Skill not found", "status": 404}
    if ".system" in p.parts:
        return {"error": "Built-in Codex skills are read-only", "status": 403}
    trash = CODEX_HOME / ".viewer-trash" / "skills"
    try:
        trash.mkdir(parents=True, exist_ok=True)
        dest = trash / f"{p.parent.name}-{int(time.time())}"
        os.rename(p.parent, dest)
    except Exception as e:
        return {"error": str(e), "status": 500}
    return {"deleted": True, "trash": str(dest)}


# ---- fork / restore (raw rollout surgery) ---------------------------------
def _codex_user_text(raw):
    try:
        p = (json.loads(raw).get("payload") or {})
        c = p.get("content")
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            return "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("text"))
    except Exception:
        pass
    return ""


def _split_codex(lines, cut_uuid):
    """(lines_before_cut, cut_message_text). None if cut_uuid isn't found —
    matched by re-hashing each raw line exactly as the adapter did."""
    before = []
    for raw in lines:
        if _uuid(raw) == cut_uuid:
            return before, _codex_user_text(raw)
        before.append(raw)
    return None, ""


def codex_fork(rel_path, cut_uuid, title=""):
    """Copy the rollout up to (not including) the cut into a fresh rollout with a
    new session id, so it resumes as its own Codex session."""
    full = resolve_agent_session("codex", rel_path)
    if not full:
        return {"error": "Session not found", "status": 404}
    lines = full.read_text(errors="replace").splitlines()
    before, cut_text = _split_codex(lines, cut_uuid)
    if before is None:
        return {"error": "Message not found in session", "status": 404}
    new_id = str(uuid_mod.uuid4())
    now = time.gmtime()
    datedir = CODEX_SESSIONS / time.strftime("%Y/%m/%d", now)
    dst = datedir / ("rollout-" + time.strftime("%Y-%m-%dT%H-%M-%S", now) + "-" + new_id + ".jsonl")
    out = []
    for raw in before:
        try:
            d = json.loads(raw)
            if d.get("type") == "session_meta":
                d.setdefault("payload", {})["id"] = new_id
                out.append(json.dumps(d))
                continue
        except Exception:
            pass
        out.append(raw)
    try:
        datedir.mkdir(parents=True, exist_ok=True)
        dst.write_text("\n".join(out) + "\n")
    except Exception as e:
        return {"error": str(e), "status": 500}
    return {"forked": True, "path": str(dst.relative_to(CODEX_SESSIONS)),
            "session": dst.stem, "codexId": new_id, "message": cut_text}


def codex_restore(rel_path, cut_uuid):
    """Truncate the rollout at the cut (conversation-only — Codex keeps no
    file-history snapshots). A .bak-<ts> copy is kept next to the file."""
    full = resolve_agent_session("codex", rel_path)
    if not full:
        return {"error": "Session not found", "status": 404}
    lines = full.read_text(errors="replace").splitlines()
    before, cut_text = _split_codex(lines, cut_uuid)
    if before is None:
        return {"error": "Message not found in session", "status": 404}
    backup = full.with_suffix(f".jsonl.bak-{int(time.time())}")
    tmp = full.with_suffix(f".jsonl.tmp-{int(time.time())}")
    try:
        # temp file + atomic swap — never leave the live rollout half-written.
        tmp.write_text("\n".join(before) + ("\n" if before else ""))
        os.replace(full, backup)
        os.replace(tmp, full)
    except Exception as e:
        try:
            tmp.unlink()
        except OSError:
            pass
        if backup.exists() and not full.exists():
            os.rename(backup, full)
        return {"error": str(e), "status": 500}
    return {"restored": True, "mode": "conversation", "backup": backup.name, "message": cut_text}


# ---- new session -----------------------------------------------------------
def start_codex_new(message, cwd, model=""):
    """Create a NEW Codex session: run `codex exec <msg>` (no resume), discover
    the rollout it writes, register a chat job for status polling, and return
    (session_id, rel_path). Returns None if the rollout never appears."""
    before = set(CODEX_SESSIONS.rglob("rollout-*.jsonl")) if CODEX_SESSIONS.is_dir() else set()
    env = dict(os.environ)
    env["PATH"] = f"{Path.home()}/.local/bin:/usr/local/bin:/usr/bin:" + env.get("PATH", "")
    cmd = [codex_bin(), "exec", "--skip-git-repo-check"]
    if model and re.fullmatch(r"[A-Za-z0-9._-]+", model):
        cmd += ["-m", model]
    cmd += [message]
    try:
        proc = subprocess.Popen(cmd, cwd=cwd, env=env, text=True, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except Exception:
        return None

    new = None
    deadline = time.time() + 25
    while time.time() < deadline:
        if CODEX_SESSIONS.is_dir():
            for f in CODEX_SESSIONS.rglob("rollout-*.jsonl"):
                if f not in before and codex_session_meta(f)[0]:
                    new = f
                    break
        if new or proc.poll() is not None:
            break
        time.sleep(0.3)
    if not new:
        return None

    session_id = new.stem
    job = {"running": True, "returncode": None, "stderr": "", "stdout": "",
           "started": time.time(), "message": message, "queue": [], "proc": proc,
           "turns": 0, "steered": 0, "stdin_open": False, "mode": "", "model": model,
           "cwd": cwd, "interrupted": False, "host": "local", "agent": "codex"}
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
    return session_id, str(new.relative_to(CODEX_SESSIONS))
