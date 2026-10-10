import { noteTemplates, orderNotes, displayTitle, previewLine, searchNotes, noteFileName, type Note } from "./notes.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const N = (o: Partial<Note> & { id: number }): Note => ({
  title: "", body: "", kind: "note", project_id: null, session_id: null, pinned: false,
  archived: false, created_by: "", created_at: 0, updated_at: 0, ...o,
})

// templates: every kind present, journal dated from the injected clock
const tpl = noteTemplates(new Date("2026-09-26T10:00:00Z"))
eq("template kinds", tpl.map((t) => t.kind), ["note", "journal", "meeting", "idea", "checklist", "discussion"])
eq("journal dated", tpl[1].body.startsWith("# 2026-09-26"), true)
eq("blank note", tpl[0].body, "")

// scope

// order: pinned first, then newest edit, then id
const ordered = orderNotes([
  N({ id: 1, updated_at: 10 }), N({ id: 2, updated_at: 30 }), N({ id: 3, updated_at: 20, pinned: true }), N({ id: 4, updated_at: 30 }),
])
eq("order", ordered.map((n) => n.id), [3, 4, 2, 1])

// titles + preview
eq("title from title", displayTitle(N({ id: 1, title: " Plan ", body: "x" })), "Plan")
eq("title from heading", displayTitle(N({ id: 1, body: "\n# Meeting — today\nbody" })), "Meeting — today")
eq("title untitled", displayTitle(N({ id: 1 })), "Untitled")
eq("preview skips title line", previewLine(N({ id: 1, body: "# Meeting — today\n\n- [ ] call Sam" })), "call Sam")
eq("preview clipped", previewLine(N({ id: 1, title: "t", body: "a".repeat(100) }), 10), "a".repeat(9) + "…")
eq("preview empty", previewLine(N({ id: 1, title: "t" })), "")

// search
const notes = [N({ id: 1, title: "Budget", body: "Q4 numbers" }), N({ id: 2, body: "grocery list" })]
eq("search title", searchNotes(notes, "bud").map((n) => n.id), [1])
eq("search body", searchNotes(notes, "GROCERY").map((n) => n.id), [2])
eq("search blank", searchNotes(notes, "  ").length, 2)

// export file name: the server's noteexport.file_name rule
eq("file name unsafe chars", noteFileName('a/b  \t c:"d"', "md"), "a b c d.md")
eq("file name trims dots", noteFileName("  .Plan. ", "pdf"), "Plan.pdf")
eq("file name fallback", noteFileName("   ", "docx"), "Note.docx")

console.log(`notes: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
