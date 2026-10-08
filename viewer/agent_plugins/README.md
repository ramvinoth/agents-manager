# Agent plugins

Each folder here is a standard Claude Code plugin (see
https://code.claude.com/docs/en/plugins-reference): `skills/<name>/SKILL.md`,
optional `.mcp.json`, `hooks/`, `agents/`. An agent template names one by folder
(`agent_templates.plugin`); the engine passes `--plugin-dir <this>/<name>` to
every Claude run of a session started from that template. Codex, Copilot and
custom-provider runs get the persona only.

The skills write into Harman's own ledgers (notes, cards) through the
`mcp__viewer__*` tools every session already has — no new storage.
