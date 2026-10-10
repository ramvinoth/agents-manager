// Exporting ONE note as a file (server: viewer/noteexport.py, GET /api/org/note/export).
// Pure: the format table, the file name and the error text. The share flow is noteExportNative.ts.
import { userError } from "./errors.ts"

export type NoteExportFormat = "md" | "docx" | "pdf"

export const NOTE_EXPORT_FORMATS: { format: NoteExportFormat; label: string; mimeType: string; UTI: string }[] = [
  { format: "md", label: "Markdown", mimeType: "text/markdown", UTI: "net.daringfireball.markdown" },
  { format: "docx", label: "Word (.docx)", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", UTI: "org.openxmlformats.wordprocessingml.document" },
  { format: "pdf", label: "PDF", mimeType: "application/pdf", UTI: "com.adobe.pdf" },
]

/** The same safe name the server puts in Content-Disposition (noteexport.file_name). */
export function noteFileName(title: string, format: NoteExportFormat): string {
  const stem = (title || "").replace(/[\\/:*?"<>#%|\x00-\x1f\s]+/g, " ").replace(/^[ .]+|[ .]+$/g, "").slice(0, 80).trim() || "Note"
  return `${stem}.${format}`
}

/** What to tell the user when the export failed. 503 = the server can't make PDFs (no Chrome there). */
export function noteExportError(e: unknown, format: NoteExportFormat): string {
  if ((e as { status?: number })?.status === 503)
    return format === "pdf" ? "This server can't make PDFs (it needs Google Chrome installed). Try Word or Markdown." : "The server couldn't export the note. Try again."
  return userError(e, "the note", "export")
}
