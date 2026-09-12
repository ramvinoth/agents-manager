"""viewer.sessions — session file operations: cwd extraction, trimming,
summaries, digests, and the StatCache utility.

Every function that reads or mutates a session JSONL lives here. The single
extract_cwd() replaces three divergent implementations (local full-scan,
remote first-100, remote-summary first-200) with one correct algorithm:
scan all lines, return the LAST cwd (matching Claude CLI's behaviour on
forks). For remote use, callers ship this function's source to the host
via inspect.getsource, so local and remote results can never drift.
"""
import glob as _glob_mod
import gzip
import json
import logging
import os
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

_log = logging.getLogger("viewer.sessions")

# --------------------------------------------------------------------------- #
# Constants for auto_trim_session                                              #
# --------------------------------------------------------------------------- #
_REQUEST_HARD_LIMIT = 20 * 1024 * 1024   # Claude Code's client-side request limit
_HEADROOM           = 2 * 1024 * 1024    # safety margin
_SESSION_TRIM_TARGET = 2 * 1024 * 1024   # target size after trim (~2 MB)
_SESSION_KEEP_LINES  = 300               # max recent lines to keep after trim
_LINE_MAX_BYTES      = 512 * 1024        # truncate any single JSONL line beyond 512 KB
_BACKUP_DIR          = Path.home() / ".claude" / "session-backups"
_BACKUP_KEEP         = 3                  # keep last N backups per session


# --------------------------------------------------------------------------- #
# StatCache                                                                    #
# --------------------------------------------------------------------------- #
class StatCache:
    """Cache keyed on an opaque key, invalidated when the source file's
    (mtime, size) change. FIFO-capped at `cap` entries. Replaces three
    hand-rolled dicts that all did this identically."""
    def __init__(self, cap=50):
        self._d = {}
        self._cap = cap
        self._lock = threading.Lock()

    def get(self, key, mtime, size):
        with self._lock:
            c = self._d.get(key)
            if c is not None and c["mtime"] == mtime and c["size"] == size:
                return c["data"]
            return None

    def put(self, key, mtime, size, data):
        with self._lock:
            self._d[key] = {"mtime": mtime, "size": size, "data": data}
            if len(self._d) > self._cap:
                self._d.pop(next(iter(self._d)))


# --------------------------------------------------------------------------- #
# extract_cwd — THE single implementation                                     #
# --------------------------------------------------------------------------- #
def extract_cwd_from_lines(lines):
    """Pure function: given an iterable of JSONL strings, return the LAST cwd.

    This is the ONE correct algorithm. Claude CLI uses the last cwd when
    resuming a forked session. Both local and remote code paths must use
    this (remote ships this source via inspect.getsource).

    Returns the cwd string, or None if no cwd field was found.
    """
    last_cwd = None
    for line in lines:
        try:
            obj = json.loads(line)
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
        if obj.get("cwd"):
            last_cwd = obj["cwd"]
    return last_cwd


def extract_cwd(session_file):
    """Find the working directory recorded in a session JSONL file.

    Returns the LAST cwd found — sessions (especially forks) can start in
    one directory and later change. The final cwd is what Claude CLI uses,
    so it must match or --resume fails.

    Falls back to deriving cwd from the parent-directory name that Claude
    CLI assigned (the canonical project path), then to $HOME.
    """
    try:
        with open(session_file, "r") as f:
            cwd = extract_cwd_from_lines(f)
    except Exception:
        cwd = None
    if cwd:
        return cwd
    # Derive from the directory name Claude CLI used (e.g. -Users-foo-proj → /Users/foo/proj)
    try:
        parent = Path(session_file).parent.name
        if parent.startswith("-"):
            return parent.replace("-", "/", 1).replace("-", "/")
    except Exception:
        pass
    return str(Path.home())


# --------------------------------------------------------------------------- #
# auto_trim_session                                                            #
# --------------------------------------------------------------------------- #
def _estimate_overhead():
    """Estimate non-JSONL overhead in the serialized request: system prompt
    + MCP tool definitions. Measures the MCP config files Claude will load,
    then adds a flat 1 MB for the system prompt itself."""
    mcp_size = 0
    for pat in ("/var/folders/*/agents_viewerperm_mcp.json",
                str(Path.home() / ".claude" / "*.mcp.json")):
        for f in _glob_mod.glob(pat):
            try:
                mcp_size += Path(f).stat().st_size
            except OSError:
                pass
    # System prompt ~200-400 KB, tool schemas expand it.
    # 1 MB flat + 4× MCP config size (schemas are verbose).
    return 1 * 1024 * 1024 + mcp_size * 4


# --------------------------------------------------------------------------- #
# Backup infrastructure: create, list, restore, prune                         #
# --------------------------------------------------------------------------- #

def _session_id_from_path(session_path):
    """Extract the UUID session id from a session file path."""
    return Path(session_path).stem  # e.g. "b5b23432-4819-4e29-a1ee-02316ee10bfa"


def _compress(src, dst):
    """Compress src to dst using zstd (subprocess), falling back to gzip."""
    zstd = shutil.which("zstd")
    if zstd:
        subprocess.run([zstd, "-3", "-q", "--rm", str(src), "-o", str(dst)],
                       check=True, timeout=300)
        return
    # Fallback: gzip via stdlib (rename dst to .gz extension)
    gz_dst = dst.with_suffix(".gz") if not str(dst).endswith(".gz") else dst
    with open(src, "rb") as f_in, gzip.open(gz_dst, "wb", compresslevel=3) as f_out:
        shutil.copyfileobj(f_in, f_out)
    src.unlink()
    if gz_dst != dst:
        gz_dst.rename(dst)


def _decompress(src, dst):
    """Decompress src to dst. Detects format from content (zstd magic or gzip magic)."""
    with open(src, "rb") as f:
        magic = f.read(4)
    if magic[:4] == b"\x28\xb5\x2f\xfd":  # zstd magic
        zstd = shutil.which("zstd")
        if zstd:
            subprocess.run([zstd, "-d", "-q", str(src), "-o", str(dst)],
                           check=True, timeout=300)
            return
        raise RuntimeError("zstd binary not found but backup is zstd-compressed")
    elif magic[:2] == b"\x1f\x8b":  # gzip magic
        with gzip.open(src, "rb") as f_in, open(dst, "wb") as f_out:
            shutil.copyfileobj(f_in, f_out)
        return
    raise RuntimeError(f"Unknown compression format in {src}")


def create_backup(session_path, reason="auto_trim"):
    """Compress the session file into BACKUP_DIR, record in DB, prune old backups.
    Returns the backup_path or None on failure."""
    try:
        from viewer import db
        p = Path(session_path)
        if not p.exists():
            return None
        session_id = _session_id_from_path(p)
        original_bytes = p.stat().st_size

        backup_dir = _BACKUP_DIR / session_id
        backup_dir.mkdir(parents=True, exist_ok=True)

        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup_name = f"{session_id}_{ts}.jsonl.zst"
        backup_path = backup_dir / backup_name

        # Copy to temp then compress (don't move — caller still needs the original)
        tmp = backup_dir / f".{backup_name}.tmp"
        shutil.copy2(str(p), str(tmp))
        _compress(tmp, backup_path)

        db.backup_create(session_id, str(backup_path), original_bytes, reason=reason)
        _prune_backups(session_id)
        _log.info("create_backup: %s → %s (%.1f MB → %.1f MB)",
                  p.name, backup_path.name,
                  original_bytes / 1024 / 1024,
                  backup_path.stat().st_size / 1024 / 1024)
        return str(backup_path)
    except Exception:
        _log.exception("create_backup failed for %s", session_path)
        return None


def _prune_backups(session_id):
    """Keep only the newest _BACKUP_KEEP backups for a session. Delete older ones."""
    from viewer import db
    rows = db.backup_list(session_id)
    for row in rows[_BACKUP_KEEP:]:
        try:
            bp = Path(row["backup_path"])
            if bp.exists():
                bp.unlink()
        except OSError:
            pass
        db.backup_delete(row["id"])


def list_backups(session_id):
    """List available backups for a session. Returns list of dicts."""
    from viewer import db
    rows = db.backup_list(session_id)
    result = []
    for r in rows:
        bp = Path(r["backup_path"])
        result.append({
            "id": r["id"],
            "session_id": r["session_id"],
            "original_bytes": r["original_bytes"],
            "trimmed_bytes": r.get("trimmed_bytes"),
            "backup_bytes": bp.stat().st_size if bp.exists() else 0,
            "reason": r["reason"],
            "created_at": str(r["created_at"]),
            "exists": bp.exists(),
        })
    return result


def restore_session(session_id, backup_id):
    """Restore a session from a backup. Returns the restored file path or raises."""
    from viewer import db
    from viewer import config as _cfg
    row = db.backup_get(backup_id)
    if not row:
        raise ValueError(f"Backup {backup_id} not found")
    if row["session_id"] != session_id:
        raise ValueError(f"Backup {backup_id} does not belong to session {session_id}")
    bp = Path(row["backup_path"])
    if not bp.exists():
        raise FileNotFoundError(f"Backup file missing: {bp}")

    # Find the session directory — scan CLAUDE_DIR for a dir containing this session
    session_file = None
    for proj_dir in _cfg.CLAUDE_DIR.iterdir():
        if not proj_dir.is_dir():
            continue
        candidate = proj_dir / f"{session_id}.jsonl"
        if candidate.exists() or candidate.with_suffix("").with_suffix(".jsonl").exists():
            session_file = candidate
            break
    if session_file is None:
        # Can't find the session dir — use the first project dir that contains
        # any jsonl file (best effort)
        for proj_dir in _cfg.CLAUDE_DIR.iterdir():
            if not proj_dir.is_dir():
                continue
            if any(proj_dir.glob("*.jsonl")):
                session_file = proj_dir / f"{session_id}.jsonl"
                break
    if session_file is None:
        raise FileNotFoundError(f"Cannot determine session directory for {session_id}")

    # Decompress backup to session path
    _decompress(bp, session_file)
    _log.info("restore_session: restored %s from backup %d (%.1f MB)",
              session_id, backup_id, session_file.stat().st_size / 1024 / 1024)
    return str(session_file)


def auto_trim_session(session_path):
    """If a session JSONL + estimated overhead would exceed Claude Code's 20 MB
    request limit, trim it. Individual lines bigger than _LINE_MAX_BYTES are
    truncated to prevent a single giant tool output from defeating the trim.

    The threshold is computed dynamically:
        max_file = 20 MB - overhead - headroom

    A compressed backup is stored in ~/.claude/session-backups/ (DB-tracked,
    last 3 kept per session)."""
    try:
        p = Path(session_path)
        size = p.stat().st_size
        overhead = _estimate_overhead()
        max_file = _REQUEST_HARD_LIMIT - overhead - _HEADROOM
        if max_file < 4 * 1024 * 1024:
            max_file = 4 * 1024 * 1024  # floor: never go below 4 MB
        if size <= max_file:
            return
        _log.info("auto_trim_session: %s is %.1f MB (overhead ~%.1f MB, max_file %.1f MB), trimming",
                   p.name, size / 1024 / 1024, overhead / 1024 / 1024, max_file / 1024 / 1024)

        # Create compressed backup before trimming
        create_backup(session_path, reason="auto_trim")

        # Read ALL header lines — the block before the first user/assistant
        # message.  Claude CLI sessions start with mode, permission-mode, and
        # system lines.  Stripping ANY of them breaks --resume.
        _CONVERSATION_TYPES = {"user", "assistant"}
        header_lines = []
        header_bytes = 0
        with open(p, "r") as f:
            for line in f:
                try:
                    t = json.loads(line).get("type")
                except (json.JSONDecodeError, ValueError):
                    t = None
                if t in _CONVERSATION_TYPES:
                    break
                header_lines.append(line)
                header_bytes += len(line.encode("utf-8"))
        if not header_lines:
            _log.warning("auto_trim_session: no header lines found in %s, skipping trim", p.name)
            return
        # Read the tail
        tail_bytes = min(4 * 1024 * 1024, p.stat().st_size)
        with open(p, "rb") as f:
            f.seek(max(0, p.stat().st_size - tail_bytes))
            chunk = f.read().decode("utf-8", "replace")
        all_tail = chunk.splitlines(keepends=True)[-_SESSION_KEEP_LINES:]
        # Walk backwards, accumulating lines until we hit the byte budget.
        # Truncate any single line that exceeds _LINE_MAX_BYTES.
        kept = []
        budget = _SESSION_TRIM_TARGET - header_bytes
        for line in reversed(all_tail):
            line_b = line.encode("utf-8")
            if len(line_b) > _LINE_MAX_BYTES:
                line_b = line_b[:_LINE_MAX_BYTES]
                line = line_b.decode("utf-8", "replace").rstrip("\n") + "...[truncated]\n"
                line_b = line.encode("utf-8")
            if budget - len(line_b) < 0 and kept:
                break
            kept.append(line)
            budget -= len(line_b)
        kept.reverse()
        # Write trimmed session atomically
        tmp = p.with_suffix(".trimtmp")
        with open(tmp, "w") as out:
            out.writelines(header_lines)
            out.writelines(kept)
        tmp.replace(p)
        new_size = p.stat().st_size
        _log.info("auto_trim_session: %s trimmed %.1f MB → %.1f MB (%d lines kept)",
                   p.name, size / 1024 / 1024, new_size / 1024 / 1024, len(kept))
        # Update the backup row with the trimmed size
        try:
            from viewer import db
            session_id = _session_id_from_path(p)
            rows = db.backup_list(session_id)
            if rows:
                latest = rows[0]
                db.backup_create.__wrapped__ if hasattr(db.backup_create, '__wrapped__') else None
                # Update trimmed_bytes on the latest backup row
                with db._db() as cur:
                    cur.execute("UPDATE session_backups SET trimmed_bytes = %s WHERE id = %s",
                                (new_size, latest["id"]))
        except Exception:
            pass  # non-critical metadata update
    except Exception:
        _log.exception("auto_trim_session failed for %s", session_path)


# --------------------------------------------------------------------------- #
# compute_session_summary                                                      #
# --------------------------------------------------------------------------- #
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


# --------------------------------------------------------------------------- #
# session_digest_from_lines                                                    #
# --------------------------------------------------------------------------- #
def session_digest_from_lines(lines, max_chars=55000):
    """Compact USER/CLAUDE transcript for the analyzer — user messages in full
    (they carry the human decisions), assistant TEXT truncated, tool noise
    dropped. Oldest turns trimmed if over the cap."""
    parts = []
    for line in lines:
        try:
            o = json.loads(line)
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
