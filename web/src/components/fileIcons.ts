// File-type → icon + accent colour, shared by the Files tab tree and the Files dialog.
import {
  Folder,
  File as FileIcon,
  FileText,
  FileCode,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
} from "lucide-react"
import type { FileEntry } from "@/lib/types"

const EXT: Record<string, { Icon: typeof FileIcon; color: string }> = {}
const reg = (icon: typeof FileIcon, color: string, exts: string[]) =>
  exts.forEach((e) => (EXT[e] = { Icon: icon, color }))
reg(FileImage, "text-violet-500", ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif", "heic"])
reg(FileVideo, "text-rose-500", ["mp4", "mov", "webm", "mkv", "avi", "m4v"])
reg(FileAudio, "text-pink-500", ["mp3", "wav", "flac", "ogg", "m4a", "aac"])
reg(FileArchive, "text-amber-500", ["zip", "tar", "gz", "tgz", "bz2", "rar", "7z", "xz"])
reg(FileCode, "text-emerald-500", [
  "js", "jsx", "ts", "tsx", "py", "go", "rs", "c", "cpp", "h", "hpp", "java", "rb", "php",
  "sh", "bash", "zsh", "json", "yaml", "yml", "toml", "html", "css", "scss", "sql", "lua",
])
reg(FileText, "text-sky-500", ["txt", "log", "csv", "tsv", "pdf", "doc", "docx", "rtf"])
reg(FileText, "text-sky-400", ["md", "markdown", "mdx"])

export function iconFor(entry: FileEntry) {
  if (entry.dir) return { Icon: Folder, color: "text-sky-500" }
  const ext = entry.name.split(".").pop()?.toLowerCase() || ""
  return EXT[ext] || { Icon: FileIcon, color: "text-muted-foreground" }
}
