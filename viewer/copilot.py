"""viewer.copilot — Copilot-CLI config surfaces: the model list, the permission
-> flag mapping, and capabilities (skills + MCP), host-aware (local + remote SSH).
Only ever reached when agent == "copilot"; the Claude/Codex/Pi flows never call
here, so they stay byte-for-byte unchanged.

Copilot CLI stores its user config under ~/.copilot: the auth token in
config.json, MCP servers in mcp-config.json, personal skills under skills/. It
shares the open SKILL.md standard with Claude, so ~/.claude/skills and
.claude/skills also count. There is no way to enumerate available models from
the CLI (no `copilot models`, and `copilot help` doesn't list them), so the
model list below is curated; availability still depends on the user's plan."""
import json
import re
import time
import urllib.request
from pathlib import Path

from viewer.engine import frontmatter_description
from viewer.remote import remote_run_python

# Claude model aliases that must never be forwarded to Copilot's --model (a
# leftover "opus"/"sonnet"/"haiku" from the Claude dropdown would error). Any
# other value the user picks or types is passed through — the CLI exposes no way
# to enumerate its (account/policy-specific) model ids, so we can't allowlist.
_CLAUDE_ALIASES = {"", "default", "opus", "sonnet", "haiku"}


# ---- dynamic model list (per-plan, like VSCode / the CLI's /model picker) ----
# There is no `copilot models` command, but the CLI/VSCode populate their picker
# by calling api.githubcopilot.com/models with the user's token and keeping only
# `model_picker_enabled` entries. We do the same, host-aware, so a Copilot
# Pro/Pro+ user automatically sees their selectable models (Opus/GPT-5/…) with
# no code change; a free plan returns none (only Default + Auto apply).
_MODELS_CACHE = {}   # host -> (expires_ts, [{"v","label"}])
_MODELS_TTL = 600
_COPILOT_MODELS_URL = "https://api.githubcopilot.com/models"
_COPILOT_HEADERS = {
    "Copilot-Integration-Id": "vscode-chat",
    "Editor-Version": "vscode/1.95",
    "Editor-Plugin-Version": "copilot-chat/0.26",
    "User-Agent": "GithubCopilot/1.155",
}


def _pick_models(payload):
    """Filter a /models response to the selectable (picker-enabled) models."""
    items = payload.get("data") if isinstance(payload, dict) else payload
    out, seen = [], set()
    for x in items or []:
        if not isinstance(x, dict) or not x.get("model_picker_enabled"):
            continue
        if (x.get("policy") or {}).get("state") == "disabled":
            continue
        mid = x.get("id")
        if not mid or mid in seen:
            continue
        seen.add(mid)
        out.append({"v": mid, "label": x.get("name") or mid})
    return out


def _copilot_oauth_token_local():
    p = Path.home() / ".copilot" / "config.json"
    try:
        raw = re.sub(r"(?m)^\s*//.*$", "", p.read_text())
        ct = (json.loads(raw).get("copilotTokens") or {})
    except Exception:
        return None
    v = next(iter(ct.values()), None) if isinstance(ct, dict) else ct
    if isinstance(v, dict):
        v = v.get("token") or next(iter(v.values()), None)
    return v if isinstance(v, str) else None


def _models_local():
    tok = _copilot_oauth_token_local()
    if not tok:
        return []
    req = urllib.request.Request(_COPILOT_MODELS_URL, headers={"Authorization": "Bearer " + tok, **_COPILOT_HEADERS})
    return _pick_models(json.loads(urllib.request.urlopen(req, timeout=15).read()))


# Same fetch on a remote host (token stays on the host; only ids come back).
COPILOT_MODELS_SCRIPT = r'''
import json, os, re, urllib.request
HDR = {"Copilot-Integration-Id":"vscode-chat","Editor-Version":"vscode/1.95",
       "Editor-Plugin-Version":"copilot-chat/0.26","User-Agent":"GithubCopilot/1.155"}
def run():
    try:
        raw = re.sub(r"(?m)^\s*//.*$", "", open(os.path.expanduser("~/.copilot/config.json")).read())
        ct = json.loads(raw).get("copilotTokens") or {}
    except Exception:
        return []
    v = None
    if isinstance(ct, dict):
        for vv in ct.values():
            v = vv; break
    else:
        v = ct
    if isinstance(v, dict):
        v = v.get("token") or next(iter(v.values()), None)
    if not isinstance(v, str):
        return []
    try:
        req = urllib.request.Request("https://api.githubcopilot.com/models",
                                     headers=dict(HDR, Authorization="Bearer " + v))
        d = json.loads(urllib.request.urlopen(req, timeout=15).read())
    except Exception:
        return []
    items = d.get("data") if isinstance(d, dict) else d
    out, seen = [], set()
    for x in items or []:
        if not isinstance(x, dict) or not x.get("model_picker_enabled"):
            continue
        if (x.get("policy") or {}).get("state") == "disabled":
            continue
        i = x.get("id")
        if not i or i in seen:
            continue
        seen.add(i)
        out.append({"v": i, "label": x.get("name") or i})
    return out
print(json.dumps(run()))
'''


def copilot_models(host="local"):
    """Selectable Copilot models for a host's account, cached ~10 min. [] if the
    plan exposes none (free plans) or the token/API is unavailable."""
    now = time.time()
    hit = _MODELS_CACHE.get(host)
    if hit and hit[0] > now:
        return hit[1]
    try:
        if host and host != "local":
            txt = remote_run_python(host, COPILOT_MODELS_SCRIPT)
            models = json.loads(txt.strip().splitlines()[-1])
        else:
            models = _models_local()
        if not isinstance(models, list):
            models = []
    except Exception:
        models = []
    _MODELS_CACHE[host] = (now + _MODELS_TTL, models)
    return models


def copilot_interactive_cmd(host, rel_path):
    """Shell command to resume a Copilot session in the FULL interactive TUI
    (all slash commands, ask_user questions, per-tool approvals). Resolves the
    copilot binary explicitly — its PATH varies per host, and a bare `copilot`
    makes zsh mis-correct to `.copilot`. Mirrors the -p driving cwd: remote runs
    from the login-shell home (like start_copilot_run), local cds to the cwd."""
    import shlex
    if host and host != "local":
        from viewer.remote import remote_copilot_bin
        sid = rel_path.split("/")[0]
        return f"{remote_copilot_bin(host)} --resume={shlex.quote(sid)}"
    from viewer.login import copilot_bin
    from viewer.adapters import resolve_agent_session
    from viewer.engine import copilot_session_meta
    full = resolve_agent_session("copilot", rel_path)
    if not full:
        return ""
    sid, cwd = copilot_session_meta(full)
    return f"cd {shlex.quote(cwd)} && {shlex.quote(copilot_bin())} --resume={shlex.quote(sid)}"


def copilot_run_flags(model="", mode=""):
    """Extra argv for a `copilot -p` run from the UI's model + permission mode.
    Passes the model through verbatim (incl. custom ids typed by the user, and
    'auto'); an invalid id surfaces Copilot's own 'model not available' error.
    'plan' -> read-only --mode plan; anything else -> --allow-all-tools."""
    flags = []
    m = (model or "").strip()
    if m and m not in _CLAUDE_ALIASES and re.fullmatch(r"[A-Za-z0-9._:-]+", m):
        flags += ["--model", m]
    if mode == "plan":
        flags += ["--mode", "plan"]
    else:  # autopilot / anything else -> full autonomy for headless driving
        flags += ["--allow-all-tools"]
    return flags


# ---- capabilities (skills + MCP), read-only display -----------------------
def _caps_local(cwd):
    """Skills + MCP for a local Copilot install, shaped like LocalHost.capabilities."""
    skills, seen = [], set()

    def add_skill(md, source):
        name = md.parent.name
        key = f"{source}:{name}"
        if key in seen:
            return
        seen.add(key)
        skills.append({"name": name, "description": frontmatter_description(md),
                       "source": source, "path": str(md), "editable": False})

    home = Path.home()
    for sub in (".copilot/skills", ".claude/skills", ".agents/skills"):
        for f in sorted((home / sub).glob("*/SKILL.md")):
            add_skill(f, "user")
    cwd_path = Path(cwd) if cwd else None
    if cwd_path:
        for sub in (".github/skills", ".claude/skills", ".agents/skills"):
            for f in sorted((cwd_path / sub).glob("*/SKILL.md")):
                add_skill(f, "project")

    mcp = []

    def add_mcp(name, cfg, scope):
        if not isinstance(cfg, dict):
            return
        transport = cfg.get("type") or ("http" if cfg.get("url") else "stdio")
        target = cfg.get("url") or " ".join([cfg.get("command", "")] + list(cfg.get("args", [])))
        mcp.append({"name": name, "scope": scope, "transport": transport,
                    "target": target.strip(), "config": cfg, "editable": False})

    def read_json(p):
        try:
            return json.loads(Path(p).read_text())
        except Exception:
            return {}

    for name, cfg in (read_json(home / ".copilot" / "mcp-config.json").get("mcpServers") or {}).items():
        add_mcp(name, cfg, "global")
    if cwd_path:
        for name, cfg in (read_json(cwd_path / ".mcp.json").get("mcpServers") or {}).items():
            add_mcp(name, cfg, "project")
        for name, cfg in (read_json(cwd_path / ".copilot" / "mcp-config.json").get("mcpServers") or {}).items():
            add_mcp(name, cfg, "project")
    return {"skills": skills, "mcp": mcp}


# Same scan as _caps_local, run on a remote host via remote_run_python. Reads CWD
# from a prepended header line; HOME from the remote's own ~.
COPILOT_CAPS_SCRIPT = r'''
import json, os, glob


def _desc(p):
    try:
        t = open(p, encoding="utf-8", errors="replace").read()
    except Exception:
        return ""
    if t.startswith("---"):
        end = t.find("\n---", 3)
        for line in (t[3:end] if end > 0 else "").splitlines():
            s = line.strip()
            if s.lower().startswith("description:"):
                return s.split(":", 1)[1].strip().strip('"\'')
    return ""


HOME = os.path.expanduser("~")
skills, seen = [], set()


def add_skill(md, source):
    name = os.path.basename(os.path.dirname(md))
    k = source + ":" + name
    if k in seen:
        return
    seen.add(k)
    skills.append({"name": name, "description": _desc(md), "source": source,
                   "path": md, "editable": False})


for sub in (".copilot/skills", ".claude/skills", ".agents/skills"):
    for md in sorted(glob.glob(os.path.join(HOME, sub, "*", "SKILL.md"))):
        add_skill(md, "user")
if CWD:
    for sub in (".github/skills", ".claude/skills", ".agents/skills"):
        for md in sorted(glob.glob(os.path.join(CWD, sub, "*", "SKILL.md"))):
            add_skill(md, "project")

mcp = []


def add_mcp(name, cfg, scope):
    if not isinstance(cfg, dict):
        return
    transport = cfg.get("type") or ("http" if cfg.get("url") else "stdio")
    target = cfg.get("url") or " ".join([cfg.get("command", "")] + list(cfg.get("args", [])))
    mcp.append({"name": name, "scope": scope, "transport": transport,
                "target": target.strip(), "config": cfg, "editable": False})


def _rj(p):
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return {}


for name, cfg in (_rj(os.path.join(HOME, ".copilot", "mcp-config.json")).get("mcpServers") or {}).items():
    add_mcp(name, cfg, "global")
if CWD:
    for name, cfg in (_rj(os.path.join(CWD, ".mcp.json")).get("mcpServers") or {}).items():
        add_mcp(name, cfg, "project")
    for name, cfg in (_rj(os.path.join(CWD, ".copilot", "mcp-config.json")).get("mcpServers") or {}).items():
        add_mcp(name, cfg, "project")

print(json.dumps({"skills": skills, "mcp": mcp}))
'''


def copilot_capabilities(host="local", cwd=""):
    """Skills + MCP for Copilot, host-aware. Read-only display for now (editing
    Copilot skills/MCP is a follow-up); shape matches LocalHost.capabilities so
    the RHS panel renders unchanged."""
    if host and host != "local":
        hdr = "CWD = " + json.dumps(cwd or "") + "\n"
        txt = remote_run_python(host, hdr + COPILOT_CAPS_SCRIPT)
        try:
            caps = json.loads(txt.strip().splitlines()[-1])
        except Exception:
            caps = {"skills": [], "mcp": []}
    else:
        caps = _caps_local(cwd)
    caps["models"] = copilot_models(host)   # dynamic per-plan model picker list
    return caps
