"""viewer.sessions — session file operations: cwd extraction,
summaries, digests, and the StatCache utility.

Every function that reads or mutates a session JSONL lives here. The single
extract_cwd() replaces three divergent implementations (local full-scan,
remote first-100, remote-summary first-200) with one correct algorithm:
return the LAST cwd (matching Claude CLI's behaviour on forks), read
backwards so a huge transcript costs milliseconds. For remote use, callers ship this function's source to the host
via inspect.getsource, so local and remote results can never drift.
"""
import json
import logging
import threading
from pathlib import Path

_log = logging.getLogger("viewer.sessions")


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
def last_cwd_in_file(fh, chunk=1 << 20):
    """Return the LAST non-empty top-level cwd in a JSONL file opened in
    BINARY mode, or None.

    This is the ONE algorithm. Claude CLI uses the last cwd when resuming a
    forked session, so the last one is the truth. It reads the file
    backwards in chunks and stops at the first (= last) cwd line. Long
    transcripts (hundreds of MB) answer in milliseconds, not the seconds a
    forward scan of every line costs. Both local and remote paths use this
    function (remote ships its source via inspect.getsource), so it must
    stay self-contained: only the `json` module.
    """
    def cwd_of(line):
        if b'"cwd"' not in line:
            return None
        try:
            obj = json.loads(line)
        except ValueError:
            return None
        cwd = obj.get("cwd") if isinstance(obj, dict) else None
        return cwd if isinstance(cwd, str) and cwd else None

    fh.seek(0, 2)
    pos = fh.tell()
    tail = b""
    while pos > 0:
        step = min(chunk, pos)
        pos -= step
        fh.seek(pos)
        lines = (fh.read(step) + tail).split(b"\n")
        tail = lines.pop(0)  # may be cut mid-line; finished on the next chunk
        for line in reversed(lines):
            cwd = cwd_of(line)
            if cwd:
                return cwd
    return cwd_of(tail)


def extract_cwd(session_file):
    """Find the working directory recorded in a session JSONL file.

    Returns the LAST cwd found — sessions (especially forks) can start in
    one directory and later change. The final cwd is what Claude CLI uses,
    so it must match or --resume fails.

    Falls back to deriving cwd from the parent-directory name that Claude
    CLI assigned (the canonical project path), then to $HOME.
    """
    try:
        with open(session_file, "rb") as f:
            cwd = last_cwd_in_file(f)
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
# compute_session_summary                                                      #
# --------------------------------------------------------------------------- #
def compute_session_summary(line_iter, cwd):
    """Full-session stats from a JSONL line iterator (local file or remote
    contents). Shared by local and remote summary paths so both produce
    identical output."""
    data = {"lines": 0, "userMessages": 0, "assistantMessages": 0, "totalInput": 0,
            "totalOutput": 0, "tools": {}, "models": [], "model": None, "title": "",
            "summaries": [], "startTime": None, "endTime": None, "cwd": cwd}
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
        elif t == "user" and not obj.get("isMeta") and not obj.get("isCompactSummary"):
            c = (obj.get("message") or {}).get("content")
            if not (isinstance(c, list) and all(isinstance(b, dict) and b.get("type") == "tool_result" for b in c)):
                data["userMessages"] += 1
        elif t == "assistant":
            data["assistantMessages"] += 1
            m = obj.get("message") or {}
            if m.get("model") and m["model"] != "<synthetic>":
                models.add(m["model"])
                data["model"] = m["model"]  # last one wins: the model the chat runs on now
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
