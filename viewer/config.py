"""viewer.config — configuration constants, paths, and dependency-free
low-level file utilities. The bottom layer of the package: imports nothing
from viewer, so every other module can import from it without a cycle."""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path

# Load optional local secrets (APNs push config etc.) from a gitignored env file
# next to this module, BEFORE anything reads os.environ. Format: KEY=value lines,
# `#` comments allowed. Existing environment always wins (explicit > file).
def _load_env_file():
    for cand in (Path(__file__).parent / ".apns.env", Path.home() / ".agents-apns.env"):
        try:
            if not cand.exists():
                continue
            for line in cand.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
        except Exception:
            pass


_load_env_file()

# Port from `server.py [PORT]`; fall back to $PORT/8091. Guard on isdigit so the
# package stays importable under pytest/other tools (whose argv[1] isn't a port).
PORT = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else int(os.environ.get("PORT", "8091"))

# How this app identifies itself on outbound HTTP. Sent on every request we make
# to a user-configured provider endpoint, because some CDNs (Cloudflare among
# them) 403 urllib's default UA outright. One constant rather than a literal per
# call site: a UA that varies by code path is a UA nobody can filter a log on.
USER_AGENT = "agents-manager/1.0"


# ===== Access control =====
# The API exposes a shell, a permission-skipping agent runner, and full FS
# read/write, so it MUST NOT be open. Every /api request + WebSocket requires a
# logged-in session (see viewer.db) — a signed session cookie. Drag-drop viewing
# is the one public path (it's entirely client-side). Set VIEWER_NO_AUTH=1 only
# when fronting the tool with your own auth/proxy.
VIEWER_NO_AUTH = os.environ.get("VIEWER_NO_AUTH") == "1"
CLAUDE_DIR = Path.home() / ".claude" / "projects"
STATIC_DIR = Path(__file__).parent.parent   # repo root (holds shared data files, e.g. system-commands.json)

# The UI is the built React app in web/dist — run `cd web && npm run build` first
# (server startup warns if it's missing).
REACT_DIR = STATIC_DIR / "web" / "dist"
UI_DIR = REACT_DIR

# Default session to auto-load. Empty by default — the UI opens the most recent
# session (or the last one you had open). Set to a "projects/<dir>/<id>.jsonl"
# relative path to pin a specific session.
DEFAULT_SESSION = os.environ.get("VIEWER_DEFAULT_SESSION", "")

# ===== Embedded desktop (optional) =====
# A URL for a remote desktop stream to show in a panel beside the terminal and
# browser. Empty by default: a plain checkout has no desktop, and the panel is
# hidden rather than offering a button that opens a blank frame.
#
# It MUST be injected rather than derived. The intended deployment is a vcode
# sandbox container, where the desktop (Neko, WebRTC) runs beside this app on
# container port 8080 — but what a browser needs is the *published* address on
# the host, and a container cannot see its own port publication. Only whoever
# created the container knows it, so only they can set this.
#
# VIEWER_DESKTOP_PASSWORD is separate because it is a credential: it is sent to
# the client only for a logged-in user (see routes/panels.py), and the desktop
# is the same trust boundary as the terminal this app already exposes.
DESKTOP_URL = os.environ.get("VIEWER_DESKTOP_URL", "").strip()
DESKTOP_PASSWORD = os.environ.get("VIEWER_DESKTOP_PASSWORD", "")
DESKTOP_USER = os.environ.get("VIEWER_DESKTOP_USER", "").strip()

MAX_POLL_BYTES = 8 * 1024 * 1024  # cap a single ?from= read
CHAT_TIMEOUT = 3600               # seconds for one claude -p run
PERM_TIMEOUT = 120                # seconds to wait for a tool-permission decision
QUESTION_TIMEOUT = 3600           # seconds to wait for an AskUserQuestion answer (a
                                  # human may take a while; the CLI holds the turn)

CHAT_JOBS = {}   # session_id -> {running, returncode, stderr, stdout, started, message}
CHAT_LOCK = threading.Lock()

PROJECTS_CACHE = {}  # host -> {"at": ts, "data": [...]}

# Full interactive command list, captured from the real CLI's "/" menu
# (see system-commands.json, regenerate with scratchpad/enum-commands.py).
SYSTEM_COMMANDS_FILE = STATIC_DIR / "system-commands.json"

# Commands the viewer implements natively instead of passing to `claude -p`.
VIEWER_HANDLED = {
    "login": "Sign in to Claude (viewer login flow)",
    "resume": "Switch to another session (opens the session picker)",
    "model": "Pick the model (use the dropdown next to Send)",
    "loop": "Run a prompt on a recurring interval (opens the Loops panel)",
    "goal": "Set a goal Claude checks before stopping (opens the Goal panel)",
    "clear": "Start a fresh session in the same project directory",
    "rename": "Rename the current session",
}

# Prompt-style commands/skills that work through headless `claude -p`.
HEADLESS_OK = {
    "compact", "init", "review", "code-review", "security-review", "simplify",
    "verify", "run", "deep-research", "recap", "todos", "context", "usage",
    "status", "batch", "insights", "release-notes", "skills",
}


def load_system_commands():
    try:
        return json.loads(SYSTEM_COMMANDS_FILE.read_text())
    except Exception:
        return {}


def claude_bin():
    """The claude binary the viewer spawns: CLAUDE_BIN, else PATH, else the two
    known local install spots.

    PATH DECIDES, DELIBERATELY — this function does not rank installs. An earlier
    revision probed every candidate's `claude --version` and spawned the newest,
    to fix a real complaint: a 15-month-old Homebrew claude kept winning on PATH
    while a current nvm install sat unused. That rule was wrong three ways, and
    each one is the kind that costs more later than the bug it fixed:

      * It makes resolution a policy decision taken in code. "Which build is
        better" belongs to whoever administers the machine, not to us — the same
        reason the model list is declared rather than ranked.
      * It gives "where is claude" side effects: N subprocesses with timeouts,
        which then need a cache, which then needs invalidation. Three mechanisms
        to answer a question PATH answers for free.
      * It is non-deterministic from the caller's side. Installing an unrelated
        nvm version silently changes which binary a session runs, and someone who
        deliberately pinned an older claude is overridden by the tool.

    The real defect in that complaint was INVISIBILITY, not precedence — nothing
    told the user which claude was about to run. That is fixed by reporting the
    resolution (see claude_bin_info, surfaced on /api/capabilities), which costs
    nothing and leaves the choice where it belongs. PATH-first also means a CLI
    that self-updates is picked up next session rather than pinned by us.
    """
    override = os.environ.get("CLAUDE_BIN")
    if override:
        return override
    found = shutil.which("claude")
    if found:
        return found
    for cand in (Path.home() / ".local/bin/claude", Path.home() / ".claude/local/claude"):
        if cand.exists():
            return str(cand)
    return "claude"


def claude_bin_info():
    """Which claude will be spawned, where it came from, and what version it is.

    The observability half of claude_bin's contract: resolution stays dumb and
    predictable, and this reports the outcome so a stale install is VISIBLE
    rather than silently out-voted. `other` lists the installs that exist but
    lost, which is what turns "why is it running an old claude" from a support
    thread into something the user can see for themselves.

    Never raises and never blocks resolution — a probe that cannot run reports an
    empty version rather than failing. Called from the capabilities route only,
    so the subprocess cost is paid when a human is looking, not on every spawn.
    """
    path = claude_bin()
    if os.environ.get("CLAUDE_BIN"):
        source = "CLAUDE_BIN"
    elif shutil.which("claude"):
        source = "PATH"
    elif path == "claude":
        source = "unresolved"
    else:
        source = "local install"

    seen, other = {str(Path(path).resolve()) if os.path.exists(path) else path}, []
    candidates = [shutil.which("claude"), str(Path.home() / ".local/bin/claude"),
                  str(Path.home() / ".claude/local/claude")]
    candidates += sorted(str(p) for p in Path.home().glob(".nvm/versions/node/*/bin/claude"))
    for cand in candidates:
        if not cand or not os.path.exists(cand):
            continue
        real = str(Path(cand).resolve())
        if real in seen:
            continue
        seen.add(real)
        other.append({"path": cand, "version": _claude_version(cand)})

    return {"path": path, "source": source, "version": _claude_version(path),
            "other": other}


def _claude_version(path):
    """`claude --version`, or "" if it cannot be run or parsed. A probe failure is
    never an error — this is reporting, not resolution."""
    try:
        out = subprocess.run([path, "--version"], capture_output=True, text=True,
                             timeout=10).stdout
        m = re.search(r"\d+\.\d+\.\d+", out)
        return m.group(0) if m else ""
    except Exception:
        return ""


def read_back_f(f, end_off, n_lines):
    """read_back on an already-open binary file object (local or SFTP)."""
    pos = end_off
    chunks = []
    newlines = 0
    block = 131072
    while pos > 0 and newlines <= n_lines:
        step = min(block, pos)
        pos -= step
        f.seek(pos)
        chunks.insert(0, f.read(step))
        newlines += chunks[0].count(b"\n")
        block = min(block * 2, 4 * 1024 * 1024)
    data = b"".join(chunks)
    base = pos
    if base > 0:
        i = data.find(b"\n")
        if i >= 0:
            data = data[i + 1:]
            base += i + 1
    lines = data.split(b"\n")
    complete = len(lines) - 1
    if complete > n_lines:
        drop = complete - n_lines
        removed = sum(len(lines[j]) + 1 for j in range(drop))
        data = data[removed:]
        base += removed
    return base, data


def read_back(path, end_off, n_lines):
    """Read up to n_lines complete lines ending at byte offset end_off.
    Returns (start_offset, data). start_offset always falls on a line start."""
    with open(path, "rb") as f:
        return read_back_f(f, end_off, n_lines)


def split_lines(data, base):
    """Split raw bytes into complete JSONL lines. A trailing chunk without a
    newline is included only if it parses as JSON (the file may be mid-write).
    Returns (lines, end_offset) where end_offset is where the next poll resumes."""
    end = base + len(data)
    if not data:
        return [], end
    parts = data.split(b"\n")
    tail = parts.pop()  # b'' when data ends with a newline
    lines = [p.decode("utf-8", "replace") for p in parts if p.strip()]
    if tail.strip():
        try:
            json.loads(tail)
            lines.append(tail.decode("utf-8", "replace"))
        except Exception:
            end -= len(tail)
    return lines, end


ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|[\x00-\x08\x0b-\x1f]")

CREDENTIALS_FILE = Path.home() / ".claude" / ".credentials.json"
VIEWER_TOKEN_FILE = Path.home() / ".claude" / ".viewer-oauth-token"

# ===== Remote hosts (SSH) =====
# Full remote parity: switch to a host and view/tail its sessions, chat (runs
# claude ON the remote), browse its filesystem. Requires claude installed and
# logged in on the remote. Credentials are stored 0600 under ~/.claude.
HOSTS_FILE = Path.home() / ".claude" / ".viewer-hosts.json"

# Configured SSH hosts, loaded once at import. Mutated in place by the hosts
# save/delete handlers (never rebound), so every module shares this one dict.
try:
    HOSTS = json.loads(HOSTS_FILE.read_text()) if HOSTS_FILE.exists() else {}
except Exception:
    HOSTS = {}
HOSTS_LOCK = threading.Lock()  # guard HOSTS mutate/iterate (save/delete vs /api/hosts)
