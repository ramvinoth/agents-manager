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
export function startBlocker(o: { title: string; message: string; aiReady: boolean; aiError: string; busy: boolean }): string {
  if (o.busy) return ""
  if (!o.aiReady) return o.aiError ? "AI settings didn't load" : "Loading AI settings…"
  // Named first: a nameless chat shows as a raw id in every list, push and
  // decision card, which is exactly where the owner needs to tell chats apart.
  if (!o.title.trim()) return "Name the chat to start"
  if (!o.message.trim()) return "Write the first message to start"
  return ""
}

// "owner/name" from what an owner pastes: the short form, a github.com page
// URL or an ssh remote. "" when it isn't one — the server only takes owner/name.
export function parseRepo(input: string): string {
  const s = input.trim().replace(/\/+$/, "").replace(/\.git$/, "")
  const m = s.match(/^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/)
  return m ? m[1] : ""
}

export type CloneStatus = { running: boolean; phase?: string; percent?: number; dir?: string; error?: string }

// Poll a started clone until it ends; resolves to the cloned folder. A few
// failed polls in a row are a dropped connection, not a failed clone — only a
// streak (or the job's own error) ends it.
export async function waitForClone(
  poll: () => Promise<CloneStatus>,
  onProgress: (text: string) => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxMisses = 5,
): Promise<string> {
  let misses = 0
  for (;;) {
    await sleep(700)
    let st: CloneStatus
    try {
      st = await poll()
      misses = 0
    } catch (e) {
      if (++misses >= maxMisses) throw e
      continue
    }
    if (st.error) throw new Error(st.error)
    if (!st.running) {
      if (!st.dir) throw new Error("The clone finished without a folder")
      return st.dir
    }
    onProgress(`${st.phase || "Cloning"}${st.percent ? ` ${st.percent}%` : ""}`)
  }
}
