// The session rail's project list. A project is a folder: the folders chats ran
// in, plus every org project on this host (made on the board, by an import or by
// an agent) — so a project shows before its first chat and can start one.
import type { OrgProject, SessionListItem } from "./types.ts"

export interface Group {
  dir: string
  project: string
  sessions: SessionListItem[]
  modified: number
  unread: boolean
  running: number
}

/** When the chat last had a message; `modified` from a server that predates it. */
export const activity = (s: SessionListItem) => s.last_message ?? s.modified

/** "/a/b/" and "/a/b" are one folder (the server's _norm_cwd rule, minus ~). */
const norm = (dir: string) => dir.replace(/\/+$/, "") || "/"

/** Folders with chats, newest activity first, then the host's chat-less projects by name. */
export function groupSessions(sessions: SessionListItem[], projects: OrgProject[], host: string): Group[] {
  const groups: Record<string, Group> = {}
  for (const s of sessions) {
    // Group by project (cwd) so it's meaningful across agents — Claude, Codex
    // and Pi all store the working directory, even though their paths differ.
    const dir = s.project || s.path.split("/").slice(0, -1).join("/")
    const key = norm(dir)
    if (!groups[key]) groups[key] = { dir, project: s.project, sessions: [], modified: 0, unread: false, running: 0 }
    groups[key].sessions.push(s)
    if (activity(s) > groups[key].modified) groups[key].modified = activity(s)
    if (s.unread) groups[key].unread = true
    if (s.running) groups[key].running += 1
  }
  const withChats = Object.values(groups).sort((a, b) => b.modified - a.modified)
  for (const g of withChats) g.sessions.sort((a, b) => activity(b) - activity(a))
  const empty: Group[] = []
  for (const p of projects) {
    const key = norm(p.cwd)
    if (p.host !== host || !p.cwd || p.missing || groups[key]) continue
    groups[key] = { dir: key, project: key, sessions: [], modified: p.created_at, unread: false, running: 0 }
    empty.push(groups[key])
  }
  empty.sort((a, b) => a.dir.localeCompare(b.dir, undefined, { sensitivity: "base" }))
  return [...withChats, ...empty]
}
