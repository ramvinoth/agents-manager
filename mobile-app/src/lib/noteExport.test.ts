import { NOTE_EXPORT_FORMATS, noteExportError, noteFileName } from "./noteExport.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

eq("formats in menu order", NOTE_EXPORT_FORMATS.map((f) => f.format), ["md", "docx", "pdf"])
eq("unsafe chars and runs of space collapse", noteFileName('a/b  \t c:"d"', "md"), "a b c d.md")
eq("dots and spaces trimmed", noteFileName("  .Plan. ", "pdf"), "Plan.pdf")
eq("empty title falls back", noteFileName("   ", "docx"), "Note.docx")
eq("long title capped at 80", noteFileName("x".repeat(200), "md").length, 83)
eq("503 on pdf explains Chrome", noteExportError({ status: 503 }, "pdf").includes("Chrome"), true)
eq("other failure is plain", noteExportError({ status: 500, message: "HTTP 500" }, "md"), "Couldn't export the note. Try again.")

console.log(`noteExport: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
