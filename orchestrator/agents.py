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
import posixpath
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


def _user_bin_dirs():
    """Agent-CLI install dirs searched AHEAD of the server's PATH."""
    if os.name != "nt":
        return [os.path.join(USER_PREFIX, "bin")]  # native claude installer; npm --prefix ~/.local
    dirs = [os.path.join(USER_PREFIX, "bin"),      # native claude.exe installer
            USER_PREFIX]                           # npm --prefix ~/.local links bins at the prefix root on Windows
    for var, sub in (("APPDATA", "npm"),           # npm's default global prefix
                     ("LOCALAPPDATA", os.path.join("Microsoft", "WinGet", "Links"))):
        if os.environ.get(var):
            dirs.append(os.path.join(os.environ[var], sub))
    return dirs


def _system_bin_dirs():
    """Searched BEHIND the server's PATH (only when missing from it): a launchd
    or systemd PATH can be minimal, but an ancient /usr/local/bin/node must
    never shadow the version-managed one the server's PATH chose."""
    return [] if os.name == "nt" else ["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin"]


def agent_path(path=None):
    """The PATH a locally spawned agent CLI runs with: the user install dirs,
    then `path` (default: the server's own PATH), then the system bin dirs it
    lacks. Joined with os.pathsep — for THIS machine only; a remote host's
    PATH is always ':'-joined by the remote shell."""
    path = os.environ.get("PATH", "") if path is None else path
    have = set(path.split(os.pathsep))
    return os.pathsep.join(_user_bin_dirs() + ([path] if path else [])
                           + [d for d in _system_bin_dirs() if d not in have])


def agent_env():
    """A copy of the server's environment with PATH set by agent_path()."""
    env = dict(os.environ)
    env["PATH"] = agent_path(env.get("PATH", ""))
    return env


def find_agent_bin(name):
    """The full path of an agent CLI on this machine, or None. shutil.which
    applies PATHEXT on Windows, so `codex` finds codex.cmd — which Popen with
    a bare name would not."""
    return shutil.which(name, path=agent_path())


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
    """Installed on this machine? The runnable binary is resolvable on
    agent_path(). NOT the home dir: a stale config dir must read as 'not
    installed' so the install flow can offer."""
    return find_agent_bin(a["bin"]) is not None


def _install_argv(a, prefix):
    """The no-sudo install for an agent: user-prefix npm into <home>/.local."""
    return ["npm", "install", "-g", "--prefix", prefix, a["pkg"]]


def install_command(a, home):
    """The install as a POSIX shell line for a remote host whose home is `home`."""
    return shlex.join(_install_argv(a, posixpath.join(home, ".local")))


def local_install_argv(a):
    """The install as an argv for this machine, npm resolved like an agent CLI
    (npm.cmd on Windows). Run it without a shell, with agent_env()."""
    argv = _install_argv(a, USER_PREFIX)
    argv[0] = find_agent_bin("npm") or "npm"
    return argv


def local_agents_status():
    return [agent_public(a, is_installed_local(a)) for a in ENABLED_AGENTS]
