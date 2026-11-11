"""Skill, command and plugin discovery from frontmatter on disk."""
import json
import os
from pathlib import Path


def frontmatter_description(path):
    """Pull `description:` out of a markdown file's YAML frontmatter."""
    try:
        with open(path, "r", errors="replace") as f:
            if f.readline().strip() != "---":
                return ""
            for _ in range(50):
                line = f.readline()
                if not line or line.strip() == "---":
                    break
                if line.strip().startswith("description:"):
                    val = line.split("description:", 1)[1].strip().strip("\"'")
                    if val in (">", "|", ">-", "|-", ""):
                        # Folded/literal block scalar: take the first indented line.
                        nxt = f.readline()
                        return nxt.strip().strip("\"'") if nxt.startswith((" ", "\t")) else ""
                    return val
    except Exception:
        pass
    return ""


def scan_command_dir(base, source, cmds):
    """Collect slash commands from a .claude/commands directory (subdirs become namespaces)."""
    if not base.is_dir():
        return
    try:
        for f in base.rglob("*.md"):
            name = str(f.relative_to(base).with_suffix("")).replace(os.sep, ":")
            cmds.setdefault(name, {"name": name, "description": frontmatter_description(f), "source": source})
    except Exception:
        pass


def scan_skill_dir(base, source, cmds):
    """Collect skills (each invocable as /<name>) from a .claude/skills directory."""
    if not base.is_dir():
        return
    try:
        for f in base.glob("*/SKILL.md"):
            name = f.parent.name
            cmds.setdefault(name, {"name": name, "description": frontmatter_description(f), "source": source})
    except Exception:
        pass


def machine_plugins(cwd=None):
    """[(name, install dir)] of the Claude Code plugins this Mac turns on for a
    run in `cwd`: installed (installed_plugins.json — user scope, or project
    scope for this folder) AND enabled in user or project settings. The cache
    keeps every old version and other projects' plugins, so globbing it would
    list things no run of this session ever loads."""
    home = Path.home() / ".claude"
    try:
        installed = json.loads((home / "plugins" / "installed_plugins.json").read_text()).get("plugins") or {}
    except Exception:
        return []
    enabled = {}
    settings = [home / "settings.json"]
    if cwd:
        settings += [Path(cwd) / ".claude" / "settings.json", Path(cwd) / ".claude" / "settings.local.json"]
    for f in settings:
        try:
            enabled.update(json.loads(f.read_text()).get("enabledPlugins") or {})
        except Exception:
            continue
    out = []
    for key, entries in installed.items():
        if not enabled.get(key):
            continue
        for e in entries if isinstance(entries, list) else []:
            if e.get("scope") == "user" or (cwd and e.get("projectPath") == str(cwd)):
                root = Path(e.get("installPath") or "")
                if root.is_dir():
                    out.append((key.split("@", 1)[0], root))
                break
    return sorted(out)


def plugin_mcp_servers(root):
    """{name: config} a plugin folder declares in its .mcp.json ({} when none)."""
    try:
        data = json.loads((Path(root) / ".mcp.json").read_text())
    except Exception:
        return {}
    servers = data.get("mcpServers") if isinstance(data, dict) else None
    return servers if isinstance(servers, dict) else {}


def plugin_description(root):
    try:
        return json.loads((Path(root) / ".claude-plugin" / "plugin.json").read_text()).get("description") or ""
    except Exception:
        return ""
