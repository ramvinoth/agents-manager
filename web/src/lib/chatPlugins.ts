/** Where a chat's plugins apply. The engine passes them (the catalog's plugins
 *  and the chat's own extras) as --plugin-dir on LOCAL Claude runs only, so the
 *  Plugins tab and "This chat" scope exist only there. Mirrors the server: the
 *  same rule lives in orchestrator/runtime/runners/claude.py (`if not remote`) and
 *  orchestrator/routes/capabilities.py (merge only for host == "local", agent claude). */

export type PluginScope = { host: string; agent: string; session?: string | null }

/** True when this chat can add or remove plugins and take "This chat" extras. */
export function chatPluginsApply({ host, agent, session }: PluginScope): boolean {
  return !!session && host === "local" && agent === "claude"
}

const AGENT_LABEL: Record<string, string> = { codex: "Codex", copilot: "Copilot" }

/** Why this chat has no plugins to toggle, or null when it has. Agent first:
 *  a Codex chat on another machine is still "not a Claude chat". */
export function pluginScopeNote(scope: PluginScope): string | null {
  if (chatPluginsApply(scope)) return null
  if (scope.agent !== "claude") {
    const name = AGENT_LABEL[scope.agent] ?? scope.agent
    return `${name} chats don't load plugins. Plugins apply to Claude chats on this Mac.`
  }
  if (scope.host !== "local") {
    return "This chat runs on another machine, so plugins don't apply. They load on Claude chats on this Mac."
  }
  return "Plugins apply to Claude chats on this Mac. Open one to add or remove them."
}
