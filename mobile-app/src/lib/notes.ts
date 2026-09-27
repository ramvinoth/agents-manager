/**
 * notes.ts — pure logic for the Notes surface (mirrors the server's viewer/db
 * notes contract). Templates, the scope rule for a filtered notes VIEW, the
 * sort every notes app uses (pinned first, newest edit next), and the list-row
 * preview derived from a markdown body. No RN imports: unit-tested under node.
 *
 * Note / NoteKind / NoteFilter are defined once in ../api/client (the server
 * contract) and re-exported here — one source of truth.
 */
import type { Note, NoteKind, NoteFilter } from "../api/client"
export type { Note, NoteKind, NoteFilter }

export type NoteTemplate = { kind: NoteKind; label: string; hint: string; body: string }

const today = (now: Date) => now.toISOString().slice(0, 10)

/** The starting body for each note kind — what Apple Notes calls a template.
 *  Pure of the clock: the caller passes `now` so tests are deterministic. */
export function noteTemplates(now: Date = new Date()): NoteTemplate[] {
  return [
    { kind: "note", label: "Note", hint: "Blank page", body: "" },
    { kind: "journal", label: "Journal", hint: "Daily entry with prompts",
      body: `# ${today(now)}\n\n## How I feel\n\n\n## What happened\n\n\n## What I learned\n\n\n## Tomorrow\n\n` },
    { kind: "meeting", label: "Meeting", hint: "Attendees, notes, actions",
      body: `# Meeting — ${today(now)}\n\n**Attendees:** \n\n## Notes\n\n\n## Decisions\n\n\n## Action items\n\n- [ ] \n` },
    { kind: "idea", label: "Idea", hint: "Capture, then shape it",
      body: `# Idea\n\n**One line:** \n\n## Why it matters\n\n\n## First step\n\n` },
    { kind: "checklist", label: "Checklist", hint: "Tasks you tick off",
      body: `# Checklist\n\n- [ ] \n- [ ] \n- [ ] \n` },
  ]
}

export const KIND_LABEL: Record<NoteKind, string> =
  { note: "Note", journal: "Journal", meeting: "Meeting", idea: "Idea", checklist: "Checklist" }

/** The scope of a notes VIEW: a chat's notes, a project's, or (the Notes tab)
 *  every note — unlike the board, notes need no columns, so an unscoped view is
 *  legitimate. A malformed scope is refused, never silently widened. */
export function notesScopeFilter(input: NoteFilter = {}): NoteFilter | null {
  const { session, project, archived } = input
  if (session !== undefined && (typeof session !== "string" || !session.trim())) return null
  if (project !== undefined && (!Number.isSafeInteger(project) || project <= 0)) return null
  return { session, project, archived: !!archived }
}

/** Pinned first, then most recently edited — the server's order, re-applied
 *  after an optimistic local edit so the list never jumps out of order. */
export function orderNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) =>
    Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at || b.id - a.id)
}

/** Title to show for a note: its title, else the first non-empty body line
 *  with markdown markers stripped, else "Untitled". */
export function displayTitle(n: Pick<Note, "title" | "body">): string {
  if (n.title.trim()) return n.title.trim()
  const line = n.body.split("\n").map((l) => l.replace(/^[#>\-*\s\[\]x]+/i, "").trim()).find(Boolean)
  return line || "Untitled"
}

/** One-line preview under the title: the first body line that is not the
 *  title itself, markers stripped, clipped to `max` chars. */
export function previewLine(n: Pick<Note, "title" | "body">, max = 90): string {
  const title = displayTitle(n)
  const line = n.body.split("\n")
    .map((l) => l.replace(/^[#>\-*\s\[\]x]+/i, "").trim())
    .find((l) => l && l !== title) || ""
  return line.length > max ? line.slice(0, max - 1) + "…" : line
}

/** Case-insensitive search over title + body. */
export function searchNotes(notes: Note[], q: string): Note[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return notes
  return notes.filter((n) => (n.title + "\n" + n.body).toLowerCase().includes(needle))
}
