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
# The address phones use to reach this server from anywhere (e.g. its Cloudflare
# Tunnel hostname). The Pair-a-phone QR defaults to it, so a customer never has
# to know or type it. Empty = the QR falls back to the browser's own address.
PUBLIC_URL = os.environ.get("HARMAN_PUBLIC_URL", "").strip().rstrip("/")
# Harman relay (relay/ — Cloudflare Worker) this server dials out to so phones
# reach it from anywhere with no tunnel or open port. Like Paseo, a fresh
# install ships pointed at the hosted relay but leaves it OFF until the owner
# switches it on while pairing a phone (persisted in settings; viewer/relay.py).
# HARMAN_RELAY_URL pins it instead: a wss:// URL = always on to that relay,
# "off" = never (the owner cannot switch it on from the app).
DEFAULT_RELAY_URL = "wss://relay.suhai.ai"
RELAY_ENV = os.environ.get("HARMAN_RELAY_URL", "").strip().rstrip("/")
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

# Agent plugins shipped with Harman: standard Claude Code plugin folders that an
# agent template names (agent_templates.plugin / plugins), a chat adds or removes,
# and the engine loads per run with --plugin-dir.
AGENT_PLUGINS_DIR = STATIC_DIR / "viewer" / "agent_plugins"


def agent_plugin_dir(name):
    """The plugin folder for a name, or None when it is blank, not a plain
    folder name (no path tricks) or not shipped here."""
    if not name or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name):
        return None
    path = AGENT_PLUGINS_DIR / name
    return path if path.is_dir() else None


def agent_plugin_names():
    """Every plugin Harman ships, by folder name — the catalog a chat or agent picks from."""
    if not AGENT_PLUGINS_DIR.is_dir():
        return []
    return sorted(p.name for p in AGENT_PLUGINS_DIR.iterdir() if agent_plugin_dir(p.name))


# A chat's own extras (skills / MCP the owner added to ONE chat) live in a
# plugin folder generated per session, so they ride the same --plugin-dir path
# as an agent's plugin instead of a second loading mechanism.
CHAT_PLUGINS_DIR = Path.home() / ".claude" / ".viewer-chat-plugins"
CHAT_PLUGIN_NAME = "chat"   # its namespace: skills show as chat:<skill>


def _extras_dir(root, key, create, description):
    """A generated extras plugin folder root/<key>, or None when the key is not
    a plain id or (create=False) it has never been written. create=True makes
    it a valid plugin (manifest) so a first skill or MCP server can land in it."""
    if not key or not re.fullmatch(r"[0-9A-Za-z-]{1,64}", key):
        return None
    path = root / key
    if create:
        (path / ".claude-plugin").mkdir(parents=True, exist_ok=True)
        manifest = path / ".claude-plugin" / "plugin.json"
        if not manifest.exists():
            manifest.write_text(json.dumps({"name": CHAT_PLUGIN_NAME, "description": description}))
    return path if path.is_dir() else None


def chat_plugin_dir(session_id, create=False):
    """The session's extras plugin folder (see _extras_dir)."""
    if not session_id or len(session_id) < 8:
        return None
    return _extras_dir(CHAT_PLUGINS_DIR, session_id, create,
                       "Skills and MCP servers added to this chat only.")


# An agent template's saved extras: copied into each new chat started from it,
# so "this agent always has these skills/MCP" needs no second loading path.
TEMPLATE_PLUGINS_DIR = Path.home() / ".claude" / ".viewer-template-plugins"


def template_plugin_dir(template_id, create=False):
    """The template's extras folder (same shape as a chat's), or None."""
    return _extras_dir(TEMPLATE_PLUGINS_DIR, str(template_id), create,
                       "Skills and MCP servers this agent starts every chat with.")


def session_plugins(meta):
    """The Harman plugins a session runs with. `agentPlugins` (the owner's
    per-chat choice) wins; a session that never chose keeps its template's
    `agentPlugin`. Unknown names are dropped, never passed to the CLI."""
    names = meta.get("agentPlugins")
    if not isinstance(names, list):
        names = [meta.get("agentPlugin") or ""]
    return [n for n in dict.fromkeys(names) if isinstance(n, str) and agent_plugin_dir(n)]


def session_plugin_dirs(session_id, meta):
    """Every --plugin-dir a local Claude run of this session gets: its Harman
    plugins, then its own extras folder when it has one."""
    dirs = [agent_plugin_dir(n) for n in session_plugins(meta)]
    chat = chat_plugin_dir(session_id)
    return dirs + ([chat] if chat else [])


# Harman's own release version. Read from the top-level VERSION file relative to
# STATIC_DIR (NOT an absolute path) so that when the server is launched from a
# release symlink (e.g. /opt/harman/current -> releases/v1.2.0), this reports the
# active release with no release-awareness in the code. Bare dev checkouts without
# a VERSION file fall back to a sentinel.
try:
    VERSION = (STATIC_DIR / "VERSION").read_text().strip() or "0.0.0-dev"
except OSError:
    VERSION = "0.0.0-dev"

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
# STT + TTS run on a GPU box as a persistent sherpa-onnx service —
# Parakeet transducer for STT, Kokoro for TTS (see deploy/speech_service.py).
# The viewer POSTs audio/text to it. Env-overridable; empty URL disables voice.
SPEECH_SERVICE_URL = os.environ.get("HARMAN_SPEECH_URL", "")
SPEECH_TIMEOUT = int(os.environ.get("HARMAN_SPEECH_TIMEOUT", "180"))  # per STT/TTS call
                                     # (Qwen synthesizes a whole reply in one
                                     # pass — a long paragraph can take 30s+)
# TTS streaming uses Pocket (:8097), which serves /synthesize_stream_aac.
# The main speech service (:8095) handles STT + non-streaming TTS but NOT
# streaming AAC. Falls back to SPEECH_SERVICE_URL if unset.
TTS_STREAM_URL = os.environ.get("HARMAN_TTS_STREAM_URL", "")
# Wake-word + speaker verification (/enroll, /segment) live on the sherpa-onnx
# service (default :8095), which may differ from HARMAN_SPEECH_URL when TTS
# streaming is pointed at a separate engine (e.g. Pocket on :8097).
VERIFY_SERVICE_URL = os.environ.get(
    "HARMAN_VERIFY_URL", "")
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


_CLAUDE_BIN_CACHE = {"at": 0.0, "bin": "", "ttl": 3600}  # resolved binary, when, how long


def _claude_version(path):
    """(major, minor, patch) parsed from `claude --version`, or () if it cannot
    be run/parsed — a probe failure must never fail the resolution."""
    try:
        # 30s, not 10: macOS scans a freshly (auto-)updated binary on first
        # exec — measured 8.5s for 2.1.289 — and a timed-out probe must not be
        # what decides which claude runs.
        out = subprocess.run([path, "--version"], capture_output=True, text=True,
                             timeout=30).stdout
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
    if _CLAUDE_BIN_CACHE["bin"] and now - _CLAUDE_BIN_CACHE["at"] < _CLAUDE_BIN_CACHE.get("ttl", 3600):
        return _CLAUDE_BIN_CACHE["bin"]
    best, best_ver, degraded = "", (), False
    for cand in _claude_candidates():
        ver = _claude_version(cand)
        if not ver:
            degraded = True
        elif ver > best_ver:
            best, best_ver = cand, ver
    if not best:
        best = shutil.which("claude") or "claude"
    # A probe that failed (binary mid-auto-update, first-exec scan) means this
    # pick may be the stale fallback, not the newest — the 2026-10-05 RSI
    # incident cached 2.1.84 for an hour exactly this way. Hold a degraded
    # answer for one minute only (not zero: a candidate that always hangs would
    # otherwise cost every run a 30s probe).
    _CLAUDE_BIN_CACHE.update({"at": now, "bin": best, "ttl": 60 if degraded else 3600})
    return best


def invalidate_claude_bin_cache():
    """Force the next claude_bin() to re-resolve from disk instead of serving
    the hourly cache. Called when a run is rejected for a too-old CLI: if the
    user has since installed/updated a newer claude (`claude update`), the very
    next run must pick it up — waiting up to an hour, or for a server restart,
    is the stale-cache half of the 2.1.84 incident (card 18)."""
    _CLAUDE_BIN_CACHE.update({"at": 0.0, "bin": "", "ttl": 3600})


# The provider (not the viewer) owns the model->minimum-CLI-version mapping and
# states it in its own rejection. LiteLLM/Copilot tags the machine-readable code
# `claude_code_version_too_old`; the raw Anthropic gate is the human sentence.
# Matching the provider's OWN words keeps this model-agnostic and future-proof:
# no {model: version} table in the viewer to go stale when the next model ships.
_VERSION_GATE_CODE = "claude_code_version_too_old"
_VERSION_GATE_RE = re.compile(
    r"(?:Claude Code|version)\s+[\d.]+\s+does not support this model"
    r"|version\s+([\d.]+)\s+or newer is required",
    re.IGNORECASE,
)


def claude_version_gate(text):
    """If `text` is a provider rejection for a too-old claude CLI, return a
    short, self-contained, actionable message a human with no context can act
    on; otherwise None. Model-agnostic: it reads the provider's own verdict
    rather than predicting which model needs which version.

    Detection is by the machine-readable error_code first, the human sentence
    as fallback (a provider that changes wording but keeps the code, or vice
    versa, still trips exactly one of the two)."""
    if not text or not isinstance(text, str):
        return None
    if _VERSION_GATE_CODE not in text and not _VERSION_GATE_RE.search(text):
        return None
    required = ""
    m = re.search(r"version\s+([\d.]+)\s+or newer is required", text, re.IGNORECASE)
    if m:
        required = m.group(1)
    have = ""
    m = re.search(r"Claude Code\s+([\d.]+)\s+does not support", text, re.IGNORECASE)
    if m:
        have = m.group(1)
    model = ""
    m = re.search(r"Model Group=([\w.\-]+)", text)
    if m:
        model = m.group(1)
    parts = ["This model needs a newer Claude Code CLI than the one running."]
    if model:
        parts[0] = f"The model {model} needs a newer Claude Code CLI than the one running."
    if have and required:
        parts.append(f"Installed: {have}; required: {required} or newer.")
    elif required:
        parts.append(f"Required: {required} or newer.")
    parts.append("Run `claude update` (or install a newer claude), then retry.")
    return " ".join(parts)


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
