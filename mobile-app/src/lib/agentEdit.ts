/** The Agents tab's create/edit form, as pure logic. The server
 *  (viewer/agenttemplates.fields_from) is the one validator; this mirrors its
 *  rules only to keep Save disabled with a reason instead of a round trip. */
import type { AgentTemplate, AgentTemplateFields, HarmanLevel } from "../api/client"
import type { NewChatJob } from "./newChat"
import { TEMPLATE_CATEGORIES } from "./templateCategories.ts"

export const NAME_MAX = 80 // viewer/agenttemplates.NAME_MAX
export const MODEL_CHOICES = ["", "sonnet", "opus", "haiku"] as const

export type AgentDraft = {
  name: string; icon: string; category: string; description: string
  system_prompt: string; goal: string; model: string; level: HarmanLevel
  jobs: NewChatJob[]
  /** Harman plugins every chat from this agent starts with. */
  plugins: string[]
  /** Not editable here, but an edit replaces every field: carried through so
   *  saving a duplicated role agent never drops its skills or lens. */
  plugin: string; lens: string
}

export function draftFrom(t?: AgentTemplate): AgentDraft {
  return {
    name: t?.name ?? "", icon: t?.icon || "sparkle",
    category: t && TEMPLATE_CATEGORIES[t.category] ? t.category : "personal",
    description: t?.description ?? "", system_prompt: t?.system_prompt ?? "", goal: t?.goal ?? "",
    model: t?.model ?? "", level: t?.level ?? "ic",
    // A template holds a schedule only; a one-shot `at` means nothing there.
    jobs: (t?.jobs ?? []).filter((j) => !j.at),
    // An agent that never kept a list brings its one seeded plugin.
    plugins: t?.plugins ?? (t?.plugin ? [t.plugin] : []),
    plugin: t?.plugin ?? "", lens: t?.lens ?? "",
  }
}

/** Why Save is off, or "" when the draft can be sent. */
export function draftBlocker(d: AgentDraft): string {
  const name = d.name.trim()
  if (!name) return "Name the agent"
  if (name.length > NAME_MAX) return `Keep the name under ${NAME_MAX} characters`
  if (d.jobs.some((j) => j.at)) return "A job on an agent repeats; pick Every N or At set times"
  return ""
}

/** The body for /api/agent-templates (create) or …/update (with id). */
export function draftPayload(d: AgentDraft): AgentTemplateFields {
  const trim = (s: string) => s.trim()
  return {
    name: trim(d.name), icon: d.icon, category: d.category, description: trim(d.description),
    system_prompt: trim(d.system_prompt), goal: trim(d.goal), model: d.model, level: d.level,
    jobs: d.jobs.map(({ prompt, cron, interval }) => (cron ? { prompt, cron } : { prompt, interval })),
    plugins: d.plugins, plugin: d.plugin, lens: d.lens,
  }
}

/** What "From this Mac" offers for an agent: the machine's skills or MCP servers
 *  the agent does not already have. A plugin's MCP server is left out — its
 *  config points inside that plugin's folder, so a copy would not run. */
export function pickable<T extends { name: string; scope?: string }>(machine: T[], onAgent: { name: string }[]): T[] {
  const have = new Set(onAgent.map((r) => r.name))
  const seen = new Set<string>()
  return machine.filter((r) => {
    if (have.has(r.name) || seen.has(r.name) || r.scope?.startsWith("plugin:")) return false
    seen.add(r.name)
    return true
  })
}
