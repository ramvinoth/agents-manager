"""viewer.chatplugins — what one chat runs with beyond the machine's own setup.

Two layers, both standard Claude Code plugins loaded with --plugin-dir (the
engine reads config.session_plugin_dirs), so there is one loading mechanism:

  - Harman plugins (the catalog, config.agent_plugin_names): the ones shipped
    in viewer/agent_plugins. A chat starts with its agent's plugins
    ("included"); the owner may add or remove any of them. A plugin is added or
    removed whole — editing one would change it for every chat that uses it.
    The list lives in session_meta.agentPlugins.
  - The chat's extras (config.chat_plugin_dir): skills and MCP servers added to
    THIS chat only, in a generated plugin named "chat" — so they show as
    chat:<skill> / plugin:chat:<server> and never collide with anyone else's.

An agent is the hub: its plugin list (agent_templates.plugins) and its own
extras (config.template_plugin_dir, same shape as a chat's) are what every new
chat from it starts with (start_from_template). The owner edits them on the
agent itself, or keeps a chat's setup on it (save_to_template). Skill and MCP
writes take the extras folder (`root`), so a chat and an agent share them.

Applies to local Claude runs only; a remote, Codex or Copilot run gets neither.
"""
import json
import shutil

from viewer import db, skills
from viewer.config import (
    CHAT_PLUGIN_NAME, agent_plugin_dir, agent_plugin_names, chat_plugin_dir, session_plugins, template_plugin_dir,
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


def extras_rows(root, source, editable):
    """An extras folder's (skill rows, MCP rows), in the capabilities shape."""
    skill_rows = [{"name": md.parent.name, "description": frontmatter_description(md),
                   "source": source, "path": str(md), "editable": editable}
                  for md in sorted((root / "skills").glob("*/SKILL.md"))]
    mcp_rows = [{"name": name, "scope": source,
                 "transport": cfg.get("type") or ("http" if cfg.get("url") else "stdio"),
                 "target": (cfg.get("url") or " ".join([cfg.get("command", "")] + list(cfg.get("args", [])))).strip(),
                 "config": cfg, "editable": editable}
                for name, cfg in plugin_mcp_servers(root).items() if isinstance(cfg, dict)]
    return skill_rows, mcp_rows


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
        skills_, mcp = extras_rows(root, source, editable)
        for row in skills_:
            key = f"{source}:{row['name']}"
            if key not in seen:
                seen.add(key)
                skill_rows.append(row)
        mcp_rows.extend(mcp)

    for name in active:
        root = agent_plugin_dir(name)
        add_parts(root, f"plugin:{name}", False)
    # Every catalog plugin is listed — on or off, ahead of the machine's — so the
    # owner can add one; "included" marks the ones the chat's agent came with.
    plugin_rows[:0] = [{"name": name, "description": plugin_description(agent_plugin_dir(name)),
                        "source": "agent", "included": name in included, "active": name in active}
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


def chat_root(sid, create=True):
    """A chat's extras folder for a write (create) or a delete (must exist)."""
    root = chat_plugin_dir(sid, create=create)
    if create and not root:
        raise ChatPluginError("Pick a local chat for chat scope", 404)
    return root


def agent_root(template_id, create=True):
    """An agent template's extras folder, same contract as chat_root."""
    root = template_plugin_dir(template_id, create=create)
    if create and not root:
        raise ChatPluginError("Agent not found", 404)
    return root


def save_skill(root, name, content):
    """Write one skill into an extras folder (a chat's or an agent's)."""
    if not skills.valid_name(name):
        raise ChatPluginError("Skill name must be letters/digits/dashes/underscores")
    d = root / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(content or "")
    return d / "SKILL.md"


def delete_skill(root, name):
    d = root / "skills" / name if root and skills.valid_name(name) else None
    if not d or not (d / "SKILL.md").is_file():
        raise ChatPluginError("Skill not found", 404)
    shutil.rmtree(d)


def copy_skill(root, skill_md):
    """An existing skill on this machine (its SKILL.md, already resolved inside
    a known skill root) copied whole — scripts and all — into an extras folder.
    Replaces one of the same name; the copy diverges from its source."""
    name = skill_md.parent.name
    if not skills.valid_name(name):
        raise ChatPluginError("Skill name must be letters/digits/dashes/underscores")
    d = root / "skills" / name
    if d.exists():
        shutil.rmtree(d)
    shutil.copytree(skill_md.parent, d)
    return d / "SKILL.md"


def install_skill_bundle(root, name, files):
    """A marketplace skill installed into one extras folder (same validation
    as skills.write_bundle: a SKILL.md, no path escaping the skill's folder)."""
    return skills.write_bundle(name, files, base=root / "skills")


def _write_mcp(root, servers):
    (root / ".mcp.json").write_text(json.dumps({"mcpServers": servers}, indent=2))


def save_mcp(root, name, cfg):
    if not name or not isinstance(cfg, dict):
        raise ChatPluginError("A server needs a name and a JSON object config")
    servers = plugin_mcp_servers(root)
    servers[name] = cfg
    _write_mcp(root, servers)


def delete_mcp(root, name):
    servers = plugin_mcp_servers(root) if root else {}
    if servers.pop(name, None) is None:
        raise ChatPluginError("Server not found", 404)
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
