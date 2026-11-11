"""orchestrator.routes.session_fork — Fork a chat at a message, and restore a chat (and its files) to an earlier point."""
import json
import os
import time
import uuid as uuid_mod
from pathlib import Path
from orchestrator import chatplugins, db
from orchestrator.codex import codex_fork, codex_restore
from orchestrator.config import CLAUDE_DIR
from orchestrator.remote import remote_session_edit


class SessionForkMixin:
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

    def _p_session_restore(self, req):
        self.handle_restore()

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

    @staticmethod
    def carry_fork_meta(parent_sid, new_sid, title=""):
        """A fork inherits the parent conversation, so it must inherit the parent's
        per-session settings too — provider, model, permission mode, effort,
        convMode, kanbanProject and any UI prefs all live in the session_meta row,
        keyed by session id, which copying the transcript alone does not carry.
        Without this the child silently falls back to defaults (a different model /
        provider / permission mode than the session it was forked from). The child
        gets its own title (its own identity) but inherits everything else. No-op
        when the parent has no meta row. Its own skills/MCP extras come along too."""
        meta = dict(db.session_meta_get(parent_sid) or {})
        if title:
            meta["title"] = title
        elif "title" in meta:
            # Don't duplicate the parent's title onto the fork; a fork with no
            # explicit title reads as "<parent> (fork)" in the list, not a twin.
            meta.pop("title", None)
        if meta:
            db.session_meta_set(new_sid, meta)
        chatplugins.fork(parent_sid, new_sid)

    def handle_fork(self):
        body = self.read_body() or {}
        host = body.get("host", "local")
        cut_uuid = body.get("uuid", "")
        agent = body.get("agent", "claude")
        if agent == "codex" and host == "local":
            title = (body.get("title") or "").strip()[:200]
            res = codex_fork(body.get("session", ""), cut_uuid, title)
            if res.get("session"):
                parent_sid = self.sid_from_path(body.get("session", "")) or ""
                self.carry_fork_meta(parent_sid, res["session"], title)
            self.send_host_result(res)
            return
        if host != "local":
            sid = self.sid_from_path(body.get("session", ""))
            title = (body.get("title") or "").strip()[:200]
            res = remote_session_edit(host, "fork", sid, uuid=cut_uuid, title=title)
            if isinstance(res, dict) and res.get("session"):
                self.carry_fork_meta(sid or "", res["session"], title)
            self.send_json(res)
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
        parent_sid = self.sid_from_path(body.get("session", "")) or full.stem
        self.carry_fork_meta(parent_sid, new_sid, title)
        self.send_json({"forked": True, "path": rel, "session": new_sid,
                        "message": self.message_text(cut)})

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
