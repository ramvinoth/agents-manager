"""viewer.routes.sessions — SessionsMixin route + business methods."""
import json
import os
import re
import subprocess
import time
import uuid as uuid_mod
from pathlib import Path
from urllib.parse import parse_qs
from viewer.config import (
    CHAT_JOBS, CLAUDE_DIR, DEFAULT_SESSION, MAX_POLL_BYTES, PROJECTS_CACHE, read_back, split_lines,
)
from viewer.adapters import list_sessions_local, normalize_lines, resolve_agent_session
from viewer.codex import codex_fork, codex_restore, start_codex_new
from viewer.engine import (
    LOOPS, LOOPS_FILE, LOOPS_LOCK, META_FILE, SESSION_META, extract_cwd, get_host, parse_interval, save_json_file, session_analysis, start_claude_run, start_copilot_new,
)
from viewer.remote import (
    remote_extract_cwd, remote_list_sessions_agent, remote_read_agent_session, remote_read_session, remote_session_edit,
)


class SessionsMixin:
    def resolve_session(self, rel_path):
        """Validate and resolve a session path; returns Path or None (error already sent)."""
        full_path = CLAUDE_DIR.parent / rel_path
        try:
            full_path = full_path.resolve()
            if not str(full_path).startswith(str(CLAUDE_DIR.parent.resolve()) + os.sep):
                self.send_error(403, "Access denied")
                return None
        except Exception:
            self.send_error(400, "Invalid path")
            return None
        if not full_path.exists():
            self.send_error(404, "Session not found")
            return None
        return full_path

    def serve_session_file(self, rel_path, query, agent="claude"):
        if agent != "claude":
            full_path = resolve_agent_session(agent, rel_path)
            if full_path is None:
                self.send_error(404, "Session not found")
                return
        else:
            full_path = self.resolve_session(rel_path)
            if full_path is None:
                return

        # Non-Claude lines are normalised to the Claude schema so the frontend
        # parser renders them unchanged. Byte offsets stay on the RAW file.
        def emit(lines):
            return normalize_lines(agent, lines) if agent != "claude" else lines

        q = parse_qs(query)
        if not any(k in q for k in ("tail", "before", "from")):
            if agent != "claude":
                self.send_error(400, "This agent's sessions require tail/from/before")
                return
            self.serve_raw_file(full_path)
            return

        size = full_path.stat().st_size
        try:
            if "from" in q:
                start = max(0, min(int(q["from"][0]), size))
                length = min(size - start, MAX_POLL_BYTES)
                with open(full_path, "rb") as f:
                    f.seek(start)
                    data = f.read(length)
                if start + length < size:
                    # Capped read: cut at the last newline so offsets stay on
                    # line boundaries for the next poll.
                    nl = data.rfind(b"\n")
                    data = data[:nl + 1] if nl >= 0 else b""
                lines, end = split_lines(data, start)
                self.send_json({"start": start, "end": end, "size": size, "lines": emit(lines)})
            elif "tail" in q:
                n = max(1, min(int(q["tail"][0]), 5000))
                start, data = read_back(full_path, size, n)
                lines, end = split_lines(data, start)
                self.send_json({"start": start, "end": end, "size": size, "lines": emit(lines)})
            else:  # before
                end_off = max(0, min(int(q["before"][0]), size))
                n = max(1, min(int((q.get("lines") or ["300"])[0]), 5000))
                start, data = read_back(full_path, end_off, n)
                lines, _ = split_lines(data, start)
                self.send_json({"start": start, "end": end_off, "size": size, "lines": emit(lines)})
        except ValueError:
            self.send_error(400, "Bad query parameter")

    @staticmethod
    def message_text(obj):
        """Plain text of a user message record (for composer prefill)."""
        content = (obj.get("message") or {}).get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
        return ""

    def handle_create_loop(self):
        body = self.read_body()
        if body is None:
            self.send_json({"error": "Invalid JSON body"}, status=400)
            return
        rel = body.get("session", "")
        prompt = (body.get("prompt") or "").strip()
        interval = parse_interval(body.get("interval", ""))
        full = self.resolve_session_quiet(rel)
        if not full:
            self.send_json({"error": "Session not found"}, status=404)
            return
        if not prompt:
            self.send_json({"error": "Empty prompt"}, status=400)
            return
        if not interval:
            self.send_json({"error": "Bad interval — use e.g. 30s, 5m, 1h"}, status=400)
            return
        model = (body.get("model") or "").strip()
        lid = uuid_mod.uuid4().hex[:12]
        with LOOPS_LOCK:
            LOOPS[lid] = {"session": full.stem, "path": rel, "prompt": prompt,
                          "interval": interval, "nextRun": time.time() + interval,
                          "runs": 0, "created": time.time(), "enabled": True, "model": model}
            save_json_file(LOOPS_FILE, LOOPS)
        self.send_json({"created": lid, "interval": interval})

    # ----- Slash commands / projects / session resolution -----

    def _g_loops(self, req):
        sid = (req.query.get("session") or [""])[0]
        with LOOPS_LOCK:
            loops = [dict(lp, id=lid) for lid, lp in LOOPS.items()
                     if not sid or lp["session"] == sid]
        self.send_json(sorted(loops, key=lambda l: l.get("created", 0)))

    def _g_default(self, req):
        self.send_json({"default": DEFAULT_SESSION})

    # ----- POST route handlers -----

    def session_busy(self, sid):
        job = CHAT_JOBS.get(sid)
        return bool(job and job["running"])

    def _p_session_delete(self, req):
        self.handle_delete_session()

    def _p_session_meta(self, req):
        body = self.read_body()
        if body is None:
            self.send_json({"error": "Invalid JSON body"}, status=400)
            return
        full = self.resolve_session_quiet(body.get("session", ""))
        if not full:
            self.send_json({"error": "Session not found"}, status=404)
            return
        sid = full.stem
        meta = SESSION_META.setdefault(sid, {})
        if "goal" in body:
            meta["goal"] = str(body["goal"]).strip()
        if "systemPrompt" in body:
            meta["systemPrompt"] = str(body["systemPrompt"]).strip()
        if "avatar" in body:
            # A short emoji/token chosen on the Session profile page. Cap length
            # so a stray payload can't bloat the persisted meta file.
            meta["avatar"] = str(body["avatar"]).strip()[:16]
        if "archived" in body:
            meta["archived"] = bool(body["archived"])
        if "favorite" in body:
            meta["favorite"] = bool(body["favorite"])
        if "pinned" in body:
            # A list of pinned message uuids. Cap count + id length so a stray
            # payload can't bloat the persisted meta file.
            meta["pinned"] = [str(x)[:80] for x in (body["pinned"] or [])][:50]
        save_json_file(META_FILE, SESSION_META)
        self.send_json({"saved": True, "goal": meta.get("goal", ""),
                        "systemPrompt": meta.get("systemPrompt", ""),
                        "avatar": meta.get("avatar", ""),
                        "archived": bool(meta.get("archived", False)),
                        "favorite": bool(meta.get("favorite", False)),
                        "pinned": meta.get("pinned", [])})

    # ----- Route tables (path -> handler). One place to see every endpoint. -----
    def _g_session_meta(self, req):
        rel = (req.query.get("session") or [""])[0]
        if req.host != "local":
            sid = rel.rsplit("/", 1)[-1].replace(".jsonl", "")
            meta = SESSION_META.get(sid) or {}
            try:
                cwd = remote_extract_cwd(req.host, rel)
            except Exception:
                cwd = ""
            self.send_json({"session": sid, "goal": meta.get("goal", ""),
                            "systemPrompt": meta.get("systemPrompt", ""),
                            "avatar": meta.get("avatar", ""), "pinned": meta.get("pinned", []), "cwd": cwd})
            return
        full = self.resolve_session_quiet(rel)
        if not full:
            self.send_json({"error": "Session not found"}, status=404)
            return
        sid = full.stem
        meta = SESSION_META.get(sid) or {}
        self.send_json({"session": sid, "goal": meta.get("goal", ""),
                        "systemPrompt": meta.get("systemPrompt", ""),
                        "avatar": meta.get("avatar", ""), "pinned": meta.get("pinned", []),
                        "cwd": extract_cwd(full)})

    def serve_remote_session_file(self, host, rel_path, q):
        if not any(k in q for k in ("tail", "before", "from")):
            self.send_json({"error": "Remote sessions require tail/from/before"}, status=400)
            return
        try:
            r = remote_read_session(host, rel_path, q)
        except Exception as e:
            self.send_json({"error": f"SSH: {e}"}, status=502)
            return
        if r is None:
            self.send_json({"error": "Session not found on host"}, status=404)
            return
        self.send_json(r)

    def _g_projects(self, req):
        self.serve_projects(req.host)

    def _p_loops_delete(self, req):
        body = self.read_body()
        lid = (body or {}).get("id", "")
        with LOOPS_LOCK:
            existed = LOOPS.pop(lid, None)
            save_json_file(LOOPS_FILE, LOOPS)
        self.send_json({"deleted": bool(existed)})

    def serve_raw_file(self, full_path):
        self.send_response(200)
        self.send_header("Content-Type", "application/jsonl")
        self.send_header("Content-Length", str(full_path.stat().st_size))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        with open(full_path, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)

    # ----- Chat -----

    def launch_claude(self, session_id, session_args, message, mode, cwd, model=""):
        """Spawn a headless claude run via the shared runner. Returns False (and
        sends a 409) if the session is already busy."""
        if not start_claude_run(session_id, session_args, message, mode, cwd, model):
            self.send_json({"error": "A message is already being processed for this session"}, status=409)
            return False
        return True

    def resolve_session_quiet(self, rel_path):
        """Like resolve_session but returns None without sending an error."""
        try:
            full_path = (CLAUDE_DIR.parent / rel_path).resolve()
            if not str(full_path).startswith(str(CLAUDE_DIR.parent.resolve()) + os.sep):
                return None
            return full_path if full_path.exists() else None
        except Exception:
            return None

    # ----- Helpers -----

    def serve_resolve(self, query, host="local"):
        """Find the JSONL file for a session id (used after starting a new session)."""
        q = parse_qs(query)
        sid = (q.get("id") or [""])[0]
        if not re.fullmatch(r"[0-9a-fA-F-]{8,40}", sid):
            self.send_json({"error": "bad id"}, status=400)
            return
        job = CHAT_JOBS.get(sid) or {}
        try:
            r = get_host(host).resolve(sid)
        except Exception as e:
            self.send_json({"found": False, "error": str(e)})
            return
        r["running"] = job.get("running", False)
        if not r.get("found"):
            r["returncode"] = job.get("returncode")
            r["stderr"] = job.get("stderr", "")
        self.send_json(r)

    # ----- Sessions -----

    def serve_projects(self, host="local"):
        """Distinct working directories seen across sessions (for the new-session
        picker), on whichever host is selected."""
        now = time.time()
        cached = PROJECTS_CACHE.get(host)
        if cached and now - cached["at"] < 60:
            self.send_json(cached["data"])
            return
        try:
            data = get_host(host).projects()
        except Exception as e:
            self.send_json({"error": f"SSH: {e}"}, status=502)
            return
        PROJECTS_CACHE[host] = {"at": now, "data": data}
        self.send_json(data)

    def _g_resolve(self, req):
        self.serve_resolve(req.raw_query, req.host)

    def _p_loops(self, req):
        self.handle_create_loop()

    def serve_remote_agent_session(self, host, agent, rel_path, q):
        if not any(k in q for k in ("tail", "before", "from")):
            self.send_json({"error": "Remote sessions require tail/from/before"}, status=400)
            return
        try:
            r = remote_read_agent_session(host, agent, rel_path, q)
        except Exception as e:
            self.send_json({"error": f"SSH: {e}"}, status=502)
            return
        if r is None:
            self.send_json({"error": "Session not found on host"}, status=404)
            return
        self.send_json(r)

    def _g_session_summary(self, req):
        self.serve_session_summary(req.raw_query, req.host)

    def _p_session_restore(self, req):
        self.handle_restore()

    def handle_delete_session(self):
        body = self.read_body() or {}
        host = body.get("host", "local")
        agent = body.get("agent", "claude")
        sid = self.sid_from_path(body.get("session", ""))
        if agent == "codex" and host == "local":
            full = resolve_agent_session("codex", body.get("session", ""))
            if not full:
                self.send_json({"error": "Session not found"}, status=404)
                return
            if self.session_busy(full.stem):
                self.send_json({"error": "A run is in progress for this session"}, status=409)
                return
            trash = Path.home() / ".codex" / ".viewer-trash"
            try:
                trash.mkdir(parents=True, exist_ok=True)
                os.rename(full, trash / full.name)
            except Exception as e:
                self.send_json({"error": str(e)}, status=500)
                return
            if SESSION_META.pop(full.stem, None) is not None:
                save_json_file(META_FILE, SESSION_META)
            from viewer import questions
            questions.clear(full.stem)
            questions.clear_plan(full.stem)
            self.send_json({"deleted": True, "trash": str(trash / full.name)})
            return
        if sid and self.session_busy(sid):
            self.send_json({"error": "A run is in progress for this session"}, status=409)
            return
        if host != "local":
            r = remote_session_edit(host, "delete", sid)
            if not r.get("error"):
                with LOOPS_LOCK:
                    for lid in [lid for lid, lp in LOOPS.items() if lp["session"] == sid]:
                        LOOPS.pop(lid, None)
                    save_json_file(LOOPS_FILE, LOOPS)
                SESSION_META.pop(sid, None) and save_json_file(META_FILE, SESSION_META)
            self.send_json(r)
            return
        full = self.resolve_session_quiet(body.get("session", ""))
        if not full:
            self.send_json({"error": "Session not found"}, status=404)
            return
        sid = full.stem
        trash = Path.home() / ".claude" / ".viewer-trash" / full.parent.name
        try:
            trash.mkdir(parents=True, exist_ok=True)
            os.rename(full, trash / full.name)
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)
            return
        with LOOPS_LOCK:
            stale = [lid for lid, lp in LOOPS.items() if lp["session"] == sid]
            for lid in stale:
                LOOPS.pop(lid, None)
            if stale:
                save_json_file(LOOPS_FILE, LOOPS)
        if SESSION_META.pop(sid, None) is not None:
            save_json_file(META_FILE, SESSION_META)
        self.send_json({"deleted": True, "trash": str(trash / full.name)})

    def split_at_uuid(self, full_path, cut_uuid):
        """Return (lines_before_cut, cut_record) — everything before the record
        whose uuid == cut_uuid. None if the uuid isn't in the file."""
        before, cut = [], None
        with open(full_path, "r") as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    before.append(line)
                    continue
                if obj.get("uuid") == cut_uuid:
                    cut = obj
                    break
                before.append(line)
        return (before, cut) if cut else (None, None)

    def _p_session_rename(self, req):
        body = self.read_body()
        if body is None:
            self.send_json({"error": "Invalid JSON body"}, status=400)
            return
        title = (body.get("title") or "").strip()[:200]
        if not title:
            self.send_json({"error": "Empty title"}, status=400)
            return
        agent = body.get("agent", "claude")
        if agent == "codex" and body.get("host", "local") == "local":
            # Codex rollouts have no title record; keep it in the viewer's own
            # SESSION_META and overlay it onto the list (see _g_sessions).
            full = resolve_agent_session("codex", body.get("session", ""))
            if not full:
                self.send_json({"error": "Session not found"}, status=404)
                return
            SESSION_META.setdefault(full.stem, {})["title"] = title
            save_json_file(META_FILE, SESSION_META)
            self.send_json({"renamed": True, "title": title})
            return
        if body.get("host", "local") != "local":
            sid = self.sid_from_path(body.get("session", ""))
            self.send_json(remote_session_edit(body["host"], "rename", sid, title=title))
            return
        full = self.resolve_session_quiet(body.get("session", ""))
        if not full:
            self.send_json({"error": "Session not found"}, status=404)
            return
        # Same record the CLI's /rename writes; appended atomically.
        rec = {"type": "custom-title", "customTitle": title, "sessionId": full.stem,
               "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())}
        try:
            with open(full, "a") as f:
                f.write(json.dumps(rec) + "\n")
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)
            return
        self.send_json({"renamed": True, "title": title})

    def snapshot_state_at(self, full_path, cut_uuid):
        """Accumulate tracked-file blob pointers (last-seen wins) up to the
        file-history checkpoint for cut_uuid — the working-tree state captured
        just before that message ran. Returns {abs_path: backupFileName|None},
        or None if cut_uuid isn't found in the file. Claude Code records each
        checkpoint as a `file-history-snapshot` keyed by messageId==the user
        turn uuid; each snapshot carries only the files that changed, so the
        full state is the running union up to and including that checkpoint."""
        parsed, cut_line, snap_line = [], None, None
        with open(full_path, "r") as f:
            for i, line in enumerate(f):
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    parsed.append(None)
                    continue
                parsed.append(d)
                if cut_line is None and d.get("type") == "user" and d.get("uuid") == cut_uuid:
                    cut_line = i
                if (d.get("type") == "file-history-snapshot"
                        and not d.get("isSnapshotUpdate")
                        and d.get("messageId") == cut_uuid):
                    snap_line = i
        if cut_line is None and snap_line is None:
            return None
        cutoff = snap_line if snap_line is not None else cut_line
        state = {}
        for i, d in enumerate(parsed):
            if i > cutoff:
                break
            if d and d.get("type") == "file-history-snapshot":
                for path, info in (d.get("snapshot", {}) or {}).get("trackedFileBackups", {}).items():
                    if isinstance(info, dict):
                        state[path] = info.get("backupFileName")
        return state

    def _p_session_fork(self, req):
        self.handle_fork()

    def handle_restore(self):
        body = self.read_body() or {}
        host = body.get("host", "local")
        cut_uuid = body.get("uuid", "")
        mode = body.get("mode", "conversation")
        if mode not in ("conversation", "code", "code+conversation"):
            mode = "conversation"
        agent = body.get("agent", "claude")
        sid = self.sid_from_path(body.get("session", ""))
        if sid and self.session_busy(sid):
            self.send_json({"error": "A run is in progress for this session — wait for it to finish"}, status=409)
            return
        if agent == "codex" and host == "local":
            # Codex has no file-history snapshots — conversation restore only.
            self.send_host_result(codex_restore(body.get("session", ""), cut_uuid))
            return
        if host != "local":
            if mode != "conversation":
                self.send_json({"error": "Code restore isn't supported on remote hosts yet"}, status=400)
                return
            self.send_json(remote_session_edit(host, "restore", sid, uuid=cut_uuid))
            return
        full = self.resolve_session_quiet(body.get("session", ""))
        if not full:
            self.send_json({"error": "Session not found"}, status=404)
            return
        before, cut = self.split_at_uuid(full, cut_uuid)
        if before is None:
            self.send_json({"error": "Message not found in session"}, status=404)
            return
        result = {"restored": True, "mode": mode}

        # ---- code restore: revert tracked files to their checkpoint content ----
        if mode in ("code", "code+conversation"):
            state = self.snapshot_state_at(full, cut_uuid)
            if state is None:
                self.send_json({"error": "No file checkpoint found for this message"}, status=404)
                return
            result["code"] = self.apply_code_restore(sid, state)

        # ---- conversation restore: truncate the transcript at the cut ----
        if mode in ("conversation", "code+conversation"):
            backup = full.with_suffix(f".jsonl.bak-{int(time.time())}")
            tmp = full.with_suffix(f".jsonl.tmp-{int(time.time())}")
            try:
                # Write the truncated copy fully to a temp file FIRST, then swap it
                # in atomically — the live session is never left half-written.
                with open(tmp, "w") as fo:
                    fo.writelines(l if l.endswith("\n") else l + "\n" for l in before)
                os.replace(full, backup)
                os.replace(tmp, full)
            except Exception as e:
                try:
                    tmp.unlink()
                except OSError:
                    pass
                if backup.exists() and not full.exists():
                    os.rename(backup, full)  # roll back the swap
                self.send_json({"error": str(e)}, status=500)
                return
            result["backup"] = backup.name
            result["message"] = self.message_text(cut)

        self.send_json(result)

    def serve_session_summary(self, query, host="local"):
        q = parse_qs(query)
        rel = (q.get("session") or [""])[0]
        try:
            data = get_host(host).session_summary(rel)
        except Exception as e:
            self.send_json({"error": f"SSH: {e}"}, status=502)
            return
        self.send_host_result(data, not_found="Session not found")

    # ----- Fork / restore / delete -----

    def _g_sessions(self, req):
        agent = (req.query.get("agent") or ["claude"])[0]
        if agent != "claude":
            try:
                sessions = (remote_list_sessions_agent(req.host, agent) if req.host != "local"
                            else list_sessions_local(agent))
                for s in sessions:  # overlay viewer-set titles (rename / new-session name)
                    meta = SESSION_META.get(s["id"], {})
                    t = meta.get("title")
                    if t:
                        s["title"] = t
                    if meta.get("avatar"):
                        s["avatar"] = meta["avatar"]
                    s["archived"] = bool(meta.get("archived", False))
                    s["favorite"] = bool(meta.get("favorite", False))
                self.send_json(sessions)
            except Exception as e:
                self.send_json({"error": f"SSH: {e}"} if req.host != "local" else {"error": str(e)},
                               status=502 if req.host != "local" else 500)
            return
        self.serve_session_list(req.host)

    def _g_session_analysis(self, req):
        rel = (req.query.get("session") or [""])[0]
        refresh = (req.query.get("refresh") or ["0"])[0] == "1"
        if not rel:
            self.send_json({"error": "No session"}, status=400)
            return
        try:
            data = session_analysis(req.host, rel, refresh=refresh)
        except subprocess.TimeoutExpired:
            self.send_json({"error": "Analysis timed out"}, status=504)
            return
        except Exception as e:
            self.send_json({"error": f"Analysis failed: {str(e)[-300:]}"}, status=500)
            return
        if data is None:
            self.send_json({"error": "Session not found"}, status=404)
            return
        self.send_json(data)

    def handle_fork(self):
        body = self.read_body() or {}
        host = body.get("host", "local")
        cut_uuid = body.get("uuid", "")
        agent = body.get("agent", "claude")
        if agent == "codex" and host == "local":
            title = (body.get("title") or "").strip()[:200]
            res = codex_fork(body.get("session", ""), cut_uuid, title)
            if title and res.get("session"):
                SESSION_META.setdefault(res["session"], {})["title"] = title
                save_json_file(META_FILE, SESSION_META)
            self.send_host_result(res)
            return
        if host != "local":
            sid = self.sid_from_path(body.get("session", ""))
            title = (body.get("title") or "").strip()[:200]
            self.send_json(remote_session_edit(host, "fork", sid, uuid=cut_uuid, title=title))
            return
        full = self.resolve_session_quiet(body.get("session", ""))
        if not full:
            self.send_json({"error": "Session not found"}, status=404)
            return
        before, cut = self.split_at_uuid(full, cut_uuid)
        if before is None:
            self.send_json({"error": "Message not found in session"}, status=404)
            return
        new_sid = str(uuid_mod.uuid4())
        dst = full.parent / f"{new_sid}.jsonl"
        title = (body.get("title") or "").strip()[:200]
        try:
            with open(dst, "w") as fo:
                for line in before:
                    try:
                        obj = json.loads(line)
                        if obj.get("sessionId"):
                            obj["sessionId"] = new_sid
                        fo.write(json.dumps(obj) + "\n")
                    except json.JSONDecodeError:
                        fo.write(line if line.endswith("\n") else line + "\n")
                if title:
                    fo.write(json.dumps({"type": "custom-title", "customTitle": title, "sessionId": new_sid,
                                         "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())}) + "\n")
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)
            return
        rel = str(dst.relative_to(CLAUDE_DIR.parent))
        self.send_json({"forked": True, "path": rel, "session": new_sid,
                        "message": self.message_text(cut)})

    def _g_session_file(self, req):
        session_path = req.path[len("/api/session/"):]
        agent = (req.query.get("agent") or ["claude"])[0]
        if req.host != "local":
            if agent != "claude":
                self.serve_remote_agent_session(req.host, agent, session_path, req.query)
            else:
                self.serve_remote_session_file(req.host, session_path, req.query)
            return
        self.serve_session_file(session_path, req.raw_query, agent)

    def _p_new_session(self, req):
        self.handle_new_session()

    def handle_new_session(self):
        """Start a brand-new claude session in a given working directory."""
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self.send_json({"error": "Invalid JSON body"}, status=400)
            return

        message = (body.get("message") or "").strip()
        mode = body.get("mode", "acceptEdits")
        model = body.get("model", "")
        host = body.get("host", "local")
        if not message:
            self.send_json({"error": "Empty message"}, status=400)
            return
        if host != "local":
            cwd = (body.get("cwd") or "~").strip()   # validated on the remote by claude
        else:
            cwd = os.path.expanduser((body.get("cwd") or "~").strip())
            if not os.path.isdir(cwd):
                self.send_json({"error": f"Not a directory: {cwd}"}, status=400)
                return

        if body.get("agent", "claude") == "codex":
            if host != "local":
                self.send_json({"error": "New Codex sessions are local-only"}, status=400)
                return
            res = start_codex_new(message, cwd, model)
            if not res:
                self.send_json({"error": "Couldn't start a Codex session (no rollout appeared)"}, status=500)
                return
            new_id, rel = res
            title = (body.get("title") or "").strip()[:200]
            if title:
                SESSION_META.setdefault(new_id, {})["title"] = title
                save_json_file(META_FILE, SESSION_META)
            self.send_json({"started": True, "session": new_id, "path": rel})
            return

        if body.get("agent", "claude") == "copilot":
            res = start_copilot_new(message, cwd, host)
            if not res:
                self.send_json({"error": "Couldn't start a Copilot session (check that Copilot is signed in on this host)"}, status=500)
                return
            new_id, rel = res
            title = (body.get("title") or "").strip()[:200]
            if title:  # Copilot has no rename convention → store the name in the viewer's meta
                SESSION_META.setdefault(new_id, {})["title"] = title
                save_json_file(META_FILE, SESSION_META)
            self.send_json({"started": True, "session": new_id, "path": rel})
            return

        session_id = str(uuid_mod.uuid4())
        # Pre-store system prompt / goal so the very first run already gets them.
        sp = (body.get("systemPrompt") or "").strip()
        goal = (body.get("goal") or "").strip()
        if sp or goal:
            SESSION_META[session_id] = {"systemPrompt": sp, "goal": goal}
            save_json_file(META_FILE, SESSION_META)
        if not start_claude_run(session_id, ["--session-id", session_id], message, mode, cwd, model, host):
            self.send_json({"error": "Busy"}, status=409)
            return
        self.send_json({"started": True, "session": session_id})

    def serve_session_list(self, host="local"):
        """List all session JSONL files with metadata, on the selected host."""
        try:
            sessions = get_host(host).list_sessions()
            # Overlay the viewer-set avatar (chosen on the Session profile page).
            # Kept in SESSION_META keyed by session id, exactly like `title`.
            if isinstance(sessions, list):
                for s in sessions:
                    meta = SESSION_META.get(s.get("id"), {})
                    if meta.get("avatar"):
                        s["avatar"] = meta["avatar"]
                    s["archived"] = bool(meta.get("archived", False))
                    s["favorite"] = bool(meta.get("favorite", False))
            self.send_json(sessions)
        except Exception as e:
            self.send_json({"error": f"SSH: {e}"}, status=502)

    def apply_code_restore(self, sid, state):
        """Overwrite each tracked file with its checkpoint content, backing up
        the current content of every file it touches first (to
        ~/.claude/.viewer-code-restore/<sid>/<ts>/, mirroring the tree). Never
        deletes files. Returns {restored, skipped, backup}."""
        hist = CLAUDE_DIR.parent / "file-history" / sid
        bkdir = CLAUDE_DIR.parent / ".viewer-code-restore" / sid / str(int(time.time()))
        restored, skipped = [], []
        for path, blob in state.items():
            if not blob:
                continue  # null backup — no stored content, leave the file as-is
            src = hist / blob
            if not src.exists():
                skipped.append(os.path.basename(path))
                continue
            try:
                content = src.read_bytes()
                dst = Path(path)
                if dst.exists() and dst.read_bytes() == content:
                    continue  # already at the checkpoint content
                if dst.exists():
                    mirror = bkdir / dst.relative_to(dst.anchor)
                    mirror.parent.mkdir(parents=True, exist_ok=True)
                    mirror.write_bytes(dst.read_bytes())
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_bytes(content)
                restored.append(os.path.basename(path))
            except Exception:
                skipped.append(os.path.basename(path))
        return {"restored": restored, "skipped": skipped,
                "backup": str(bkdir) if restored else None}

