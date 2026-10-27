# Agent plugins

Each folder here is a standard Claude Code plugin (see
https://code.claude.com/docs/en/plugins-reference): `.claude-plugin/plugin.json`
(name + one-line description), `skills/<name>/SKILL.md`, optional `.mcp.json`,
`hooks/`, `agents/`. An agent template names one by folder
(`agent_templates.plugin`); a chat started from it shows that plugin as
**Included**.

Per chat, the owner adds or removes any of these plugins (Plugins tab →
`POST /api/chat/plugin`, stored as `session_meta.agentPlugins`; an empty list
means "removed"). A plugin is whole — add or remove, never edited per chat.
Skills and MCP servers the owner adds with "this chat" scope live in a
generated plugin named `chat` under `~/.claude/.viewer-chat-plugins/<sid>/`
(see `viewer/chatplugins.py`); forks copy it, deleting the chat purges it.

"Keep on agent" (`POST /api/chat/save-to-agent`, human-only) snapshots a chat's
plugin list into `agent_templates.plugins` and its extras into
`~/.claude/.viewer-template-plugins/<template id>/`; every later chat from that
agent starts with both (its own copy). The builtin re-seed never touches
`plugins`, so a kept setup survives upgrades; deleting the template purges it.

**The agent is the hub.** Its editor (Agents tab → edit) picks its plugins
(`plugins` on `POST /api/agent-templates[/update]`) and adds its own skills and
MCP servers (`POST /api/agent-templates/extra`, owner-only, stored in the same
template extras folder); `GET /api/agent-templates/extras?id=` lists them with
the plugin catalog. New plugins ship here, in git — there is no per-user plugin
catalog: a reusable setup is an agent, not a plugin.

Agents themselves can be personal: `agent_templates.owner_user_id` is the
account that made one (NULL = shared builtins). Create, edit, duplicate and
delete live in `viewer/agenttemplates.py` (rules) and the agent-template routes;
builtins are changed only by duplicating them.

The engine passes one `--plugin-dir` per active plugin plus the chat's extras
to every **local** Claude run. Plugin parts are namespaced (`<plugin>:<skill>`,
`plugin:<plugin>:<server>`), so they never collide with user/project skills or
MCP. Remote, Codex, Copilot and custom-provider runs get the persona only.

The skills write into Harman's own ledgers (notes, cards) through the
`mcp__viewer__*` tools every session already has — no new storage.
