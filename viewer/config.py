"""viewer.config — configuration constants, paths, and dependency-free
low-level file utilities. The bottom layer of the package: imports nothing
from viewer, so every other module can import from it without a cycle."""
import json
import os
import re
import shutil
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

MAX_POLL_BYTES = 8 * 1024 * 1024  # cap a single ?from= read
CHAT_TIMEOUT = 3600               # seconds for one claude -p run
PERM_TIMEOUT = 120                # seconds to wait for a tool-permission decision
QUESTION_TIMEOUT = 3600           # seconds to wait for an AskUserQuestion answer (a
                                  # human may take a while; the CLI holds the turn)

# ===== Voice (speech-to-text + text-to-speech) =====
# STT + TTS run on the GPU box (suha-ai) as a persistent sherpa-onnx service —
# Parakeet transducer for STT, Kokoro for TTS (see deploy/speech_service.py).
# The viewer POSTs audio/text to it. Env-overridable; empty URL disables voice.
SPEECH_SERVICE_URL = os.environ.get("HARMAN_SPEECH_URL", "http://100.115.120.89:8095")
SPEECH_TIMEOUT = int(os.environ.get("HARMAN_SPEECH_TIMEOUT", "180"))  # per STT/TTS call
                                     # (Qwen synthesizes a whole reply in one
                                     # pass — a long paragraph can take 30s+)
# Wake-word + speaker verification (/enroll, /segment) live on the sherpa-onnx
# service (default :8095), which may differ from HARMAN_SPEECH_URL when TTS
# streaming is pointed at a separate engine (e.g. Pocket on :8097).
VERIFY_SERVICE_URL = os.environ.get(
    "HARMAN_VERIFY_URL", "http://100.115.120.89:8095")
VERIFY_TIMEOUT = int(os.environ.get("HARMAN_VERIFY_TIMEOUT", "20"))  # per segment

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
