// The note export flow on the phone: pick a format, download it, open the share sheet.
// Used by the note's ⋯ menu (NoteEditorScreen) and a long press on a notes-list row (NotesScreen).
import * as FileSystem from "expo-file-system"
import * as Sharing from "expo-sharing"
import { api } from "../api/client"
import { showActions } from "./actionSheet"
import { NOTE_EXPORT_FORMATS, noteExportError, noteFileName, type NoteExportFormat } from "./noteExport"

/** Asks Markdown / Word / PDF, then shares the file. `onError` gets plain text. */
export function exportNote(note: { id: number; title: string }, onError: (msg: string) => void) {
  showActions("Export as", NOTE_EXPORT_FORMATS.map((f) => ({ text: f.label, onPress: () => { shareNote(note, f.format).catch((e) => onError(noteExportError(e, f.format))) } })))
}

async function shareNote(note: { id: number; title: string }, format: NoteExportFormat) {
  const f = NOTE_EXPORT_FORMATS.find((x) => x.format === format)!
  // A per-export folder: two exports of same-titled notes never overwrite each other mid-share.
  const dir = `${FileSystem.cacheDirectory}note-export-${Date.now()}/`
  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true })
    const dest = dir + noteFileName(note.title, format)
    const status = await api.orgNoteExport(note.id, format, dest)
    if (status >= 400) throw Object.assign(new Error(`HTTP ${status}`), { status })
    if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing isn't available on this device.")
    await Sharing.shareAsync(dest, { mimeType: f.mimeType, UTI: f.UTI, dialogTitle: noteFileName(note.title, format) })
  } finally {
    FileSystem.deleteAsync(dir, { idempotent: true }).catch(() => {})
  }
}
