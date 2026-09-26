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
import time
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
# A preflight boot (spare port, same Postgres, live server still running) only
# proves the code imports and serves. It must not act on shared state: boot
# reconciliation would close the live server's in-flight job_runs as "restarted
# mid-run" and sweep the settings files its runs are using, and a second
# scheduler would fire due loops twice.
VIEWER_PREFLIGHT = os.environ.get("VIEWER_PREFLIGHT") == "1"
CLAUDE_DIR = Path.home() / ".claude" / "projects"


def transcript_path(session_id):
    """The local transcript of a session, or None: <project-dir>/<id>.jsonl one
    level under CLAUDE_DIR (the CLI's layout). The one rule every resolver
    shares — the scheduler cannot resume a session this returns None for."""
    if not session_id:
        return None
    matches = list(CLAUDE_DIR.glob(f"*/{session_id}.jsonl"))
    return matches[0] if matches else None
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
CHAT_TIMEOUT = 3600               # seconds for one claude -p run (one-shot paths:
                                  # a hard wall-clock cap on communicate())
# Streaming chat is capped on SILENCE, not total wall-clock: a genuinely-working
# agent (emitting assistant text / tool calls / results as stream-json lines)
# may run for hours, but a hung claude -p that goes quiet mid-turn is killed
# after this many seconds of NO output. Must exceed the longest legitimate
# silent gap — a long-running tool call (build/test suite) emits nothing on the
# stream until it returns — so keep this generous. Env-overridable for tuning.
CHAT_IDLE_TIMEOUT = int(os.environ.get("VIEWER_CHAT_IDLE_TIMEOUT", "1800"))
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
# TTS streaming uses Pocket (:8097), which serves /synthesize_stream_aac.
# The main speech service (:8095) handles STT + non-streaming TTS but NOT
# streaming AAC. Falls back to SPEECH_SERVICE_URL if unset.
TTS_STREAM_URL = os.environ.get("HARMAN_TTS_STREAM_URL", "http://100.115.120.89:8097")
# Wake-word + speaker verification (/enroll, /segment) live on the sherpa-onnx
# service (default :8095), which may differ from HARMAN_SPEECH_URL when TTS
# streaming is pointed at a separate engine (e.g. Pocket on :8097).
VERIFY_SERVICE_URL = os.environ.get(
    "HARMAN_VERIFY_URL", "http://100.115.120.89:8095")
VERIFY_TIMEOUT = int(os.environ.get("HARMAN_VERIFY_TIMEOUT", "20"))  # per segment

# ===== Nemotron turn-based voicechat (deploy/voicechat_service.py) =====
# A SEPARATE, single-slot GPU backend (see deploy/voicechat.md) — not the
# sherpa-onnx STT/TTS service above. Empty URL/token-file disables it: no
# production default, so a fresh install never proxies to a box it hasn't
# been pointed at. The service token lives in a private file (same 0600
# read-a-secret-file convention as VIEWER_TOKEN_FILE / viewer/login.py),
# never in an env var a process listing could show, and is read fresh on
# each request rather than cached in memory at import time.
NEMOTRON_URL = os.environ.get("HARMAN_NEMOTRON_URL", "")
NEMOTRON_TOKEN_FILE = (Path(os.environ["HARMAN_NEMOTRON_TOKEN_FILE"])
                      if os.environ.get("HARMAN_NEMOTRON_TOKEN_FILE") else None)
NEMOTRON_TIMEOUT = int(os.environ.get("HARMAN_NEMOTRON_TIMEOUT", "15"))  # /health only

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


_CLAUDE_BIN_CACHE = {"at": 0.0, "bin": ""}  # resolved binary + when (hourly re-resolve)


def _claude_version(path):
    """(major, minor, patch) parsed from `claude --version`, or () if it cannot
    be run/parsed — a probe failure must never fail the resolution."""
    try:
        out = subprocess.run([path, "--version"], capture_output=True, text=True,
                             timeout=10).stdout
        m = re.search(r"(\d+)\.(\d+)\.(\d+)", out)
        return tuple(int(g) for g in m.groups()) if m else ()
    except Exception:
        return ()


def _claude_candidates():
    """Every claude install on this machine, de-duplicated by real path:
    the server-PATH hit, the two local install spots, and every nvm node
    version that has one. Order here is irrelevant — the version decides."""
    cands = []
    found = shutil.which("claude")
    if found:
        cands.append(found)
    cands += [str(p) for p in (Path.home() / ".local/bin/claude",
                               Path.home() / ".claude/local/claude")]
    cands += sorted(str(p) for p in Path.home().glob(".nvm/versions/node/*/bin/claude"))
    seen, out = set(), []
    for c in cands:
        if not os.path.exists(c):
            continue
        real = str(Path(c).resolve())
        if real not in seen:
            seen.add(real)
            out.append(c)
    return out


def claude_bin():
    """The claude binary the viewer spawns. The explicit CLAUDE_BIN env var
    always wins (the operator's call, never version-checked). Otherwise the
    NEWEST install among the known locations wins — because a first-on-PATH
    hit that is months stale is exactly the failure that bit us: the viewer
    pinned the 2.1.84 Homebrew Cask (2026-04), whose stdio-MCP hang was fixed
    upstream (2.1.105/2.1.187), while a current nvm install sat unused. The
    newest-binary rule makes the invariant ("spawn a current claude") true
    regardless of which install channel drifts; an hour-long cache keeps the
    per-run cost at zero and picks up fresh installs without a restart."""
    override = os.environ.get("CLAUDE_BIN")
    if override:
        return override
    now = time.time()
    if _CLAUDE_BIN_CACHE["bin"] and now - _CLAUDE_BIN_CACHE["at"] < 3600:
        return _CLAUDE_BIN_CACHE["bin"]
    best, best_ver = "", ()
    for cand in _claude_candidates():
        ver = _claude_version(cand)
        if ver and ver > best_ver:
            best, best_ver = cand, ver
    if not best:
        best = shutil.which("claude") or "claude"
    _CLAUDE_BIN_CACHE.update({"at": now, "bin": best})
    return best


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
# logged in on the remote. The host registry (labels, users, credentials) lives
# in Postgres — see viewer.db.hosts_load / host_upsert / host_delete.
