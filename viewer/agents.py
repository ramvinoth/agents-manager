"""Agent registry — the seam for supporting coding agents beyond Claude Code.

The viewer's model is "discover per-project transcripts -> tail & parse ->
render -> drive a CLI." Each agent describes where it lives on disk and how to
install it; discovery, transcript normalisation, auth and launch are layered on
per-agent. Claude Code is the baseline (its flow is unchanged); Codex and Pi are
the next adapters — both store per-project JSONL, so they reuse the pipeline.

This module holds only static metadata + local install detection so it stays
import-safe (no dependency on server.py). Remote detection and the HTTP route
live in server.py, which has the SSH helpers.
"""
import os
import shlex
import shutil

# Ordered: Claude first (default/baseline), then the file-JSONL agents.
# "enabled": False hides an agent everywhere in the UI (picker, install/login,
# remote probing) without ripping out its adapter — existing sessions of a
# disabled agent still parse (get_agent/AGENTS_BY_ID stay complete).
AGENTS = [
    {
        "id": "claude", "label": "Claude Code", "vendor": "Anthropic",
        "bin": "claude", "home": "~/.claude", "sessions": "~/.claude/projects",
        "pkg": "@anthropic-ai/claude-code", "login": "claude",
        "install": "npm install -g @anthropic-ai/claude-code",
        "docs": "https://docs.claude.com/claude-code",
        "enabled": True,
    },
    {
        "id": "codex", "label": "Codex", "vendor": "OpenAI",
        "bin": "codex", "home": "~/.codex", "sessions": "~/.codex/sessions",
        "pkg": "@openai/codex", "login": "codex login",
        "install": "npm install -g @openai/codex",
        "docs": "https://developers.openai.com/codex/cli",
        "enabled": True,
    },
    {
        "id": "pi", "label": "Pi", "vendor": "earendil-works",
        "bin": "pi", "home": "~/.pi", "sessions": "~/.pi/agent/sessions",
        "pkg": "@earendil-works/pi-coding-agent", "login": "pi",
        "install": "npm install -g @earendil-works/pi-coding-agent",
        "docs": "https://pi.dev",
        "enabled": True,
    },
    # GitHub Copilot CLI (`copilot`, npm @github/copilot). Full support: picker +
    # install/detection, non-interactive driving (`copilot -p "…"`) and the
    # interactive TUI, plus model/permission mapping. It persists each session as
    # a *set of files* under ~/.copilot/session-state/<id>/events.jsonl (+ a
    # session-store.db SQLite index), NOT one JSONL per project like the others;
    # `adapters._copilot_line` normalises those events to the Claude schema.
    # Login is interactive (`/login`) or a PAT with the "Copilot Requests" scope.
    {
        "id": "copilot", "label": "Copilot CLI", "vendor": "GitHub",
        "bin": "copilot", "home": "~/.copilot", "sessions": "~/.copilot/session-state",
        "pkg": "@github/copilot", "login": "copilot",
        "install": "npm install -g @github/copilot",
        "docs": "https://github.com/github/copilot-cli",
        "enabled": True,
    },
]

AGENTS_BY_ID = {a["id"]: a for a in AGENTS}
# What the UI (and remote probes) see — disabled harnesses are filtered out here.
ENABLED_AGENTS = [a for a in AGENTS if a.get("enabled", True)]
DEFAULT_AGENT = "claude"

# Where the viewer installs agents without sudo: a user-writable prefix in $HOME.
USER_PREFIX = os.path.expanduser("~/.local")
_BIN_DIRS = [os.path.join(USER_PREFIX, "bin"), "/usr/local/bin", "/usr/bin",
             "/opt/homebrew/bin", os.path.expanduser("~/.local/bin")]


def get_agent(aid):
    """The agent dict for an id, falling back to the default (never None)."""
    return AGENTS_BY_ID.get(aid or DEFAULT_AGENT) or AGENTS_BY_ID[DEFAULT_AGENT]


def agent_public(a, installed):
    """The JSON-safe view of an agent sent to the frontend."""
    return {
        "id": a["id"], "label": a["label"], "vendor": a["vendor"],
        "bin": a["bin"], "home": a["home"], "install": a["install"],
        "login": a.get("login", a["bin"]), "docs": a["docs"], "installed": bool(installed),
    }


def is_installed_local(a):
    """Installed on this machine? The runnable binary is resolvable — on PATH or
    in a common bin dir (~/.local/bin, /usr/local/bin, …). NOT the home dir: a
    stale config dir must read as 'not installed' so the install flow can offer."""
    if shutil.which(a["bin"]):
        return True
    return any(os.path.exists(os.path.join(d, a["bin"])) for d in _BIN_DIRS)


def install_command(a, home):
    """The no-sudo install command for an agent: user-prefix npm into $HOME/.local."""
    prefix = os.path.join(home, ".local")
    return f"npm install -g --prefix {shlex.quote(prefix)} {shlex.quote(a['pkg'])}"


def local_agents_status():
    return [agent_public(a, is_installed_local(a)) for a in ENABLED_AGENTS]
