/**
 * Pure decisions behind the New chat screen — kept out of the screen so they
 * are tested without a simulator.
 */
import type { Project } from "../api/client"

/** A job the new chat starts with — JobScheduler's output plus its prompt. */
export type NewChatJob = { prompt: string; cron?: string; interval?: number; at?: string }

/** Permission modes, each with the one line the owner needs to pick one. */
export const MODES = [
  { v: "acceptEdits", label: "Accept edits", hint: "Edits files; asks before commands" },
  { v: "default", label: "Ask", hint: "Asks before every edit and command" },
  { v: "plan", label: "Plan", hint: "Reads and plans; changes nothing" },
  { v: "bypassPermissions", label: "Bypass", hint: "Never asks — full access" },
]

export function modeOf(v: string) {
  return MODES.find((m) => m.v === v) ?? MODES[0]
}

function parts(p: string): string[] {
  return p.split("/").filter(Boolean)
}

/** Last path segment ("~" stays "~"). */
export function folderName(p: string): string {
  const s = parts(p)
  return s.length ? s[s.length - 1] : p
}

/**
 * Picker labels for recent folders: the folder name, widened with its parent
 * only when two recent folders share a name — otherwise "api" and "api" are
 * indistinguishable and the chat starts in the wrong repo.
 */
export function projectOptions(projects: Project[], limit = 12): { v: string; label: string }[] {
  const recent = projects.slice(0, limit)
  const count = new Map<string, number>()
  for (const p of recent) count.set(folderName(p.cwd), (count.get(folderName(p.cwd)) ?? 0) + 1)
  return recent.map((p) => {
    const name = folderName(p.cwd)
    const s = parts(p.cwd)
    const label = (count.get(name) ?? 0) > 1 && s.length > 1 ? `${s[s.length - 2]}/${name}` : name
    return { v: p.cwd, label }
  })
}

/** The thread header until the transcript's own title loads. */
export function chatLabel(title: string, cwd: string, session: string): string {
  return title.trim() || (cwd.trim() ? folderName(cwd.trim()) : "") || session.slice(0, 8)
}

/** Why Start is disabled, or "" when it can run — shown, never left implicit. */
export function startBlocker(o: { message: string; aiReady: boolean; aiError: string; busy: boolean }): string {
  if (o.busy) return ""
  if (!o.aiReady) return o.aiError ? "AI settings didn't load" : "Loading AI settings…"
  if (!o.message.trim()) return "Write the first message to start"
  return ""
}
