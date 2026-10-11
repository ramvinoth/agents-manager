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

The engine passes one `--plugin-dir` per active plugin plus the chat's extras
to every **local** Claude run. Plugin parts are namespaced (`<plugin>:<skill>`,
`plugin:<plugin>:<server>`), so they never collide with user/project skills or
MCP. Remote, Codex, Copilot and custom-provider runs get the persona only.

The skills write into Harman's own ledgers (notes, cards) through the
`mcp__viewer__*` tools every session already has — no new storage.
