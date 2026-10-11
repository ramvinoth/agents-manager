"""viewer.chatplugins — what one chat runs with beyond the machine's own setup.

Two layers, both standard Claude Code plugins loaded with --plugin-dir (the
engine reads config.session_plugin_dirs), so there is one loading mechanism:

  - Harman plugins (the catalog, config.plugin_sources): the shipped ones in
    viewer/agent_plugins and the owner's own, saved from a chat's extras
    (save_as_plugin). A chat starts with its agent template's plugin
    ("included"); the owner may add or remove any catalog plugin. A plugin is added or removed whole — editing one would change it for
    every chat that uses it. The list lives in session_meta.agentPlugins.
  - The chat's extras (config.chat_plugin_dir): skills and MCP servers added to
    THIS chat only, in a generated plugin named "chat" — so they show as
    chat:<skill> / plugin:chat:<server> and never collide with anyone else's.

An agent template can keep a chat's setup (save_to_template): its plugin list
(agent_templates.plugins) and a copy of the extras (config.template_plugin_dir),
which every new chat from that agent starts with (start_from_template).

Applies to local Claude runs only; a remote, Codex or Copilot run gets neither.
"""
import json
import re
import shutil

from viewer import db, skills
from viewer.config import (
    CHAT_PLUGIN_NAME, PLUGIN_NAME_RE, agent_plugin_dir, agent_plugin_names, chat_plugin_dir, plugin_source,
    plugin_sources, session_plugins, template_plugin_dir,
)
from viewer.engine import frontmatter_description, plugin_description, plugin_mcp_servers


class ChatPluginError(ValueError):
    def __init__(self, msg, status=400):
        super().__init__(msg)
        self.status = status


def _meta(sid):
    return db.session_meta_get(sid) or {}


def _included(meta, template):
    """The plugins this chat's agent brings: what the agent kept (its saved
    list), else its seeded plugin."""
    if template and isinstance(template.get("plugins"), list):
        return set(template["plugins"])
    return {meta.get("agentPlugin") or ""}


def merge_into(caps, sid):
    """Add this chat's Harman plugins and extras to a capabilities dict
    ({skills, mcp, plugins}) — read-only rows for plugin parts, editable rows
    for the chat's own extras — plus the catalog of plugins it could add."""
    meta = _meta(sid)
    tid = meta.get("agentTemplate")
    template = db.agent_template_get(tid) if tid else None
    included = _included(meta, template)
    if template:   # the agent this chat came from — the target of "Keep on agent"
        caps["agent"] = {"id": template["id"], "name": template.get("name") or ""}
    active = session_plugins(meta)
    skill_rows = caps.setdefault("skills", [])
    mcp_rows = caps.setdefault("mcp", [])
    plugin_rows = caps.setdefault("plugins", [])
    seen = {f"{s.get('source')}:{s.get('name')}" for s in skill_rows}

    def add_parts(root, source, editable):
        for md in sorted((root / "skills").glob("*/SKILL.md")):
            key = f"{source}:{md.parent.name}"
            if key not in seen:
                seen.add(key)
                skill_rows.append({"name": md.parent.name, "description": frontmatter_description(md),
                                   "source": source, "path": str(md), "editable": editable})
        for name, cfg in plugin_mcp_servers(root).items():
            if isinstance(cfg, dict):
                mcp_rows.append({"name": name, "scope": source,
                                 "transport": cfg.get("type") or ("http" if cfg.get("url") else "stdio"),
                                 "target": (cfg.get("url") or " ".join([cfg.get("command", "")] + list(cfg.get("args", [])))).strip(),
                                 "config": cfg, "editable": editable})

    for name in active:
        root = agent_plugin_dir(name)
        add_parts(root, f"plugin:{name}", False)
    # Every catalog plugin is listed — on or off, ahead of the machine's — so the
    # owner can add one; "included" marks the one the chat's agent came with,
    # `kind` whether it shipped with Harman or the owner saved it (deletable).
    plugin_rows[:0] = [{"name": name, "description": plugin_description(agent_plugin_dir(name)),
                        "source": "agent", "kind": plugin_source(name).kind,
                        "included": name in included, "active": name in active}
                       for name in agent_plugin_names()]
    extras = chat_plugin_dir(sid)
    if extras:
        add_parts(extras, CHAT_PLUGIN_NAME, True)
    return caps


def set_plugin(sid, name, on):
    """Add or remove one Harman plugin for this chat. Returns the new list."""
    if not agent_plugin_dir(name):
        raise ChatPluginError("Unknown plugin", 404)
    current = session_plugins(_meta(sid))
    if on:
        names = current if name in current else current + [name]
    else:
        names = [n for n in current if n != name]
    db.session_meta_patch(sid, {"agentPlugins": names})
    return names


def save_skill(sid, name, content):
    root = chat_plugin_dir(sid, create=True)
    if not root:
        raise ChatPluginError("Not a session id")
    if not skills.valid_name(name):
        raise ChatPluginError("Skill name must be letters/digits/dashes/underscores")
    d = root / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(content or "")
    return d / "SKILL.md"


def install_skill_bundle(sid, name, files):
    """A marketplace skill installed into this chat only (same validation as
    skills.write_bundle: a SKILL.md, no path escaping the skill's folder)."""
    root = chat_plugin_dir(sid, create=True)
    if not root:
        raise ChatPluginError("Not a session id")
    return skills.write_bundle(name, files, base=root / "skills")


def _write_mcp(root, servers):
    (root / ".mcp.json").write_text(json.dumps({"mcpServers": servers}, indent=2))


def save_mcp(sid, name, cfg):
    if not name or not isinstance(cfg, dict):
        raise ChatPluginError("A server needs a name and a JSON object config")
    root = chat_plugin_dir(sid, create=True)
    if not root:
        raise ChatPluginError("Not a session id")
    servers = plugin_mcp_servers(root)
    servers[name] = cfg
    _write_mcp(root, servers)


def delete_mcp(sid, name):
    root = chat_plugin_dir(sid)
    servers = plugin_mcp_servers(root) if root else {}
    if servers.pop(name, None) is None:
        raise ChatPluginError("Server not found in this chat", 404)
    _write_mcp(root, servers)


def _replace(src, dst_root):
    """Make dst_root an exact copy of src (or remove it when src is None)."""
    if dst_root and dst_root.exists():
        shutil.rmtree(dst_root)
    if src:
        shutil.copytree(src, dst_root)


def fork(parent_sid, new_sid):
    """A fork inherits the parent's extras (a copy — the two diverge from here)."""
    src = chat_plugin_dir(parent_sid)
    dst = chat_plugin_dir(new_sid, create=True) if src else None
    if dst:
        shutil.copytree(src, dst, dirs_exist_ok=True)


def start_from_template(template, sid):
    """Meta fields + extras for a new chat started from an agent template. The
    template's saved plugin list wins over its single seeded plugin; its saved
    extras are copied in (the chat's copy diverges from here)."""
    fields = {"agentTemplate": template["id"], "agentPlugin": template.get("plugin") or ""}
    if isinstance(template.get("plugins"), list):
        fields["agentPlugins"] = template["plugins"]
    src = template_plugin_dir(template["id"])
    dst = chat_plugin_dir(sid, create=True) if src else None
    if dst:
        shutil.copytree(src, dst, dirs_exist_ok=True)
    return fields


def save_to_template(sid):
    """Keep this chat's plugins and extras on the agent it was started from, so
    every later chat from that agent starts with them. Replaces what the agent
    kept before (an exact snapshot, so a removed skill stays removed)."""
    meta = _meta(sid)
    tid = meta.get("agentTemplate")
    if not tid or not db.agent_template_get(tid):
        raise ChatPluginError("This chat was not started from an agent", 404)
    plugins = session_plugins(meta)
    db.agent_template_set_plugins(tid, plugins)
    src = chat_plugin_dir(sid)
    dst = template_plugin_dir(tid, create=True)
    _replace(src, dst)
    return {"saved": True, "template": tid, "plugins": plugins}


def copy_template_extras(src_id, dst_id):
    """A duplicated agent starts with a copy of its source's saved extras."""
    src = template_plugin_dir(src_id)
    if src:
        _replace(src, template_plugin_dir(dst_id, create=True))


def _user_source():
    return next(s for s in plugin_sources() if s.writable)


def save_as_plugin(sid, name, description=""):
    """Package this chat's extras (its own skills and MCP servers) as a new
    plugin in the owner's catalog, so any chat or agent can add it whole.

    A new name only — an existing plugin is never overwritten, since chats
    already running with it would change under them. The chat keeps its
    extras; turning the plugin on as well would load every skill twice."""
    name = (name or "").strip().lower()
    if not re.fullmatch(PLUGIN_NAME_RE, name) or name == CHAT_PLUGIN_NAME:
        raise ChatPluginError("Name it with lowercase letters, digits and dashes, e.g. sales-research")
    if plugin_source(name):
        raise ChatPluginError(f"A plugin named {name} already exists", 409)
    src = chat_plugin_dir(sid)
    if not src or not (any((src / "skills").glob("*/SKILL.md")) or plugin_mcp_servers(src)):
        raise ChatPluginError("This chat has no skills or MCP tools of its own to save")
    dst = _user_source().root / name
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dst)
    (dst / ".claude-plugin" / "plugin.json").write_text(json.dumps(
        {"name": name, "description": (description or "").strip() or "Saved from a chat."}, indent=2))
    return {"saved": True, "name": name}


def delete_user_plugin(name):
    """Remove one of the owner's saved plugins from the catalog. Shipped ones
    are read-only. A chat or agent still naming it simply stops loading it
    (session_plugins drops unknown names)."""
    src = plugin_source(name or "")
    if not src:
        raise ChatPluginError("Plugin not found", 404)
    if not src.writable:
        raise ChatPluginError("Plugins that ship with Harman can't be deleted", 403)
    shutil.rmtree(src.dir(name))
    return {"deleted": True, "name": name}


def purge(sid):
    """Drop the chat's extras folder — called when the chat is deleted."""
    root = chat_plugin_dir(sid)
    if root:
        shutil.rmtree(root, ignore_errors=True)


def purge_template(template_id):
    """Drop an agent template's saved extras — called when the template is deleted."""
    root = template_plugin_dir(template_id)
    if root:
        shutil.rmtree(root, ignore_errors=True)
