"""Session titles and push labels: what a session is called in lists and notifications."""
import json
import os
from datetime import datetime
from pathlib import Path

from orchestrator import db
from orchestrator.config import transcript_path

"""orchestrator.engine — agent runners (claude/codex/pi), chat control, loops,
session summaries, skill scans, and the Host local/remote seam."""


# Claude encodes a session's cwd as its project-dir name (every "/" -> "-"); the
# current user's home prefix, encoded the same way, lets us show "~/…" generically.
_HOME_ENC = str(Path.home()).replace("/", "-")


# ===== Loops (recurring prompts per session) and session meta =====
# Both stores live in Postgres now (orchestrator.db) — the single source of truth. Call
# sites read/write per row through db.loop_* / db.session_meta_* instead of mutating
# a shared in-memory dict and rewriting a whole JSON file. Postgres gives the
# atomicity the old module-level locks used to provide.
def _newer(latest, obj):
    """The later of `latest` and a user/assistant record's ISO `timestamp` (epoch
    seconds). Bookkeeping records (cost-state, last-prompt, …) carry no timestamp
    and so never count as activity."""
    ts = obj.get("timestamp")
    if obj.get("type") not in ("user", "assistant") or not isinstance(ts, str):
        return latest
    try:
        t = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return latest
    return t if latest is None or t > latest else latest


def session_title(session_id):
    """(explicit title, first user message) from the transcript head: the
    explicit one is a custom title or agent name, as the chat list shows it.
    Kept apart so a name the session was created with outranks a prompt's
    opening line (the "session:Setup run. Create a note…" label). Best-effort.

    Cached per transcript (mtime, size): the decision feed asks for every
    open decision's session title on a 4 s poll from every open board, and a
    parse of the transcript head per call is an N+1 disk read on that hot
    path. An idle session's file never changes, so its title is read once."""
    try:
        path = transcript_path(session_id)
        if not path:
            return "", ""
        st = os.stat(path)
        stamp = (st.st_mtime, st.st_size)
        hit = _TITLE_CACHE.get(session_id)
        if hit and hit[0] == stamp:
            return hit[1]
        title = _read_session_title(path)
        _TITLE_CACHE[session_id] = (stamp, title)
        return title
    except Exception:
        return "", ""


_TITLE_CACHE = {}


def _read_session_title(path):
    title = first_user = ""
    with open(path, errors="replace") as f:
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
    return " ".join(title.split())[:60], " ".join(first_user.split())[:60]


def _project_label(session_id):
    """The project the session's transcript lives in, read off the CLAUDE_DIR
    layout (the project dir is the cwd with '/' -> '-', e.g.
    -Users-alice-src-agents -> 'agents'). The last resolvable name
    before a raw id: a session with no custom title, no goal and no cwd still
    gets 'agents' instead of 'Chat 65cf166a'."""
    try:
        path = transcript_path(session_id)
        if not path:
            return ""
        return os.path.basename(str(path.parent).replace("-", "/").rstrip("/"))
    except Exception:
        return ""


def push_label(session_id, cwd=""):
    """A short human title for a push notification: the session's explicit name
    (transcript title, else the name it was created with), else its first message,
    else its goal, else the working-directory basename,
    else the project the transcript lives in, else a short session id. The raw-id
    fallback is the LAST resort — a bare 'Chat <id>' is useless for the owner to
    tell which session is asking (#31/#42)."""
    meta = db.session_meta_get(session_id) or {}
    title, first_user = session_title(session_id)
    name = title or (meta.get("title") or "").strip() or first_user
    if name:
        return name
    goal = (meta.get("goal") or "").strip()
    if goal:
        return goal[:60]
    if cwd:
        base = os.path.basename(cwd.rstrip("/"))
        if base:
            return base
    proj = _project_label(session_id)
    if proj:
        return proj
    return f"Chat {str(session_id)[:8]}"
