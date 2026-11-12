"""The Host seam: one interface over local and remote session files and shell."""
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from orchestrator.config import CLAUDE_DIR, transcript_path
from orchestrator.history import HistoryView
from orchestrator.remote import (
    remote_capabilities,
    remote_extract_cwd,
    remote_fs,
    remote_list_sessions,
    remote_mcp_probe,
    remote_mcp_save,
    remote_projects,
    remote_resolve,
)
from orchestrator.runtime.plugins import (
    frontmatter_description,
    machine_plugins,
    plugin_description,
    plugin_mcp_servers,
)
from orchestrator.runtime.summaries import StatCache, _session_project, extract_cwd, remote_session_summary
from orchestrator.runtime.titles import _newer
from orchestrator.sessions import compute_session_summary

# ===== Host: the local-vs-remote seam =====
#
# One interface over "where the session files and shell live." Every filesystem
# / session / config query goes through it, so a feature can't silently target
# the LOCAL box when a remote host is selected — the recurring bug class this
# project kept hitting. LocalHost holds the logic that used to be inline in the
# route handlers; RemoteHost delegates to the proven remote_* helpers over SSH.
# Handlers do `host = get_host(hid); host.<method>()` — no `if hid == "local"`.
_TCC_GUARDED = ("Desktop", "Documents", "Downloads")


def _responsible_app():
    """The .app macOS charges this process's privacy grants to: the bundle whose
    executable is our parent (Manager.app's launcher on an installed Mac). None
    when the server was started some other way (a terminal, a bare launchd job)."""
    try:
        exe = subprocess.run(["ps", "-o", "comm=", "-p", str(os.getppid())],
                             capture_output=True, text=True, timeout=2).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.match(r"(.*/([^/]+)\.app)/Contents/MacOS/", exe)
    return (m.group(2), m.group(1)) if m else None


def _permission_denied_hint(p):
    """The 403 text for a folder this server's process may not read. On macOS,
    Desktop/Documents/Downloads under the home folder are gated per app by
    privacy consent (TCC), not by unix mode bits — the owner can `ls` them in
    Terminal while a launchd-started python cannot. Name the switch to flip, and
    the entry it lists under: the wrapping app when there is one, else the
    interpreter; elsewhere the plain unix answer is the truth."""
    try:
        rel = p.relative_to(Path.home())
    except ValueError:
        return "Permission denied"
    if sys.platform == "darwin" and rel.parts and rel.parts[0] in _TCC_GUARDED:
        head = (f"macOS blocks this server from reading ~/{rel.parts[0]} (privacy consent). "
                "Open System Settings → Privacy & Security → Full Disk Access, ")
        app = _responsible_app()
        if app:
            return head + (f"turn on “{app[0]}” (or click +, press ⌘⇧G and paste  {app[1]} ), "
                           "then restart the server.")
        exe = sys.executable or "the python interpreter running this server"
        return head + (f"click +, press ⌘⇧G, and paste this exact path:  {exe}  — it lists under "
                       "that binary's own name (e.g. “Python”). Enable it, then restart the server.")
    return "Permission denied"


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
    def resolve(self, sid): raise NotImplementedError
    def list_sessions(self): raise NotImplementedError
    def mcp_save(self, name, scope, cfg, cwd, delete): raise NotImplementedError
    def mcp_probe(self, name, cfg, cwd): raise NotImplementedError


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
            return {"error": _permission_denied_hint(p), "status": 403}
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
        machine = machine_plugins(cwd)
        for name, root in machine:
            for f in sorted((root / "skills").glob("*/SKILL.md")):
                add_skill(f, f"plugin:{name}", False)

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
        for pname, root in machine:
            for name, cfg in plugin_mcp_servers(root).items():
                add_mcp(name, cfg, f"plugin:{pname}", False)
        plugins = [{"name": name, "description": plugin_description(root), "source": "machine",
                    "included": False, "active": True} for name, root in machine]
        return {"skills": skills, "mcp": mcp, "plugins": plugins}

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
        # The whole history: rows its trims dropped, then the live transcript.
        with HistoryView(full) as view:
            data = compute_session_summary(view.lines(), extract_cwd(full))
        LOCAL_SUMMARY_CACHE.put(key, st.st_mtime, st.st_size, data)
        return data

    def resolve(self, sid):
        path = transcript_path(sid)
        if path:
            return {"found": True, "path": str(path.relative_to(CLAUDE_DIR.parent))}
        return {"found": False}

    @staticmethod
    def _preview_from(obj):
        """Chat-list preview from one transcript record: 'You: …' for user text,
        plain text for assistant. Returns None for records that aren't visible
        messages (tool results, meta records, <command…> wrappers)."""
        t = obj.get("type")
        if t not in ("user", "assistant") or obj.get("isMeta") or obj.get("isCompactSummary"):
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
            title, session_id, preview, last_message = "", jsonl_file.stem, "", None
            try:
                # The last 50KB (the whole file when smaller) holds the newest
                # title, preview and message time in one pass.
                with open(jsonl_file, "r") as f:
                    if stat.st_size > 50000:
                        f.seek(stat.st_size - 50000); f.readline()
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
                        last_message = _newer(last_message, obj)
                # A long chat's title may sit only near its start: the head
                # fills it, never replacing the tail's newer preview.
                tail_preview = preview
                if stat.st_size > 50000 and (not title or not preview):
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
                            if p and not tail_preview:
                                preview = p
                            last_message = _newer(last_message, obj)
            except Exception:
                pass
            project = _session_project(jsonl_file)
            sessions.append({"id": session_id, "path": str(jsonl_file.relative_to(CLAUDE_DIR.parent)),
                             "title": title or session_id[:8], "project": project,
                             "size": stat.st_size, "modified": stat.st_mtime,
                             # When the last message was written. The
                             # file's mtime also moves when Claude appends
                             # bookkeeping on resume/exit (cost-state,
                             # last-prompt, permission-mode), so unread and the
                             # list's time read this, not `modified`.
                             "last_message": last_message or stat.st_mtime,
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

    def mcp_probe(self, name, cfg, cwd):
        from orchestrator.mcp_probe import probe
        return probe(name, cfg, cwd)


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

    def mcp_probe(self, name, cfg, cwd):
        return remote_mcp_probe(self.hid, name, cfg, cwd)

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
