// The Files tab's tree, as pure data: which rows are visible given the folders
// loaded so far and the folders the user expanded. The component only fetches
// listings and draws these rows (VSCode-style explorer).
import type { FileEntry } from "./types.ts"

/** Join a folder and a child name without doubling the slash. */
export const joinPath = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : dir + "/" + name)

/** Folders first, then names in natural, case-insensitive order (file10 after file9). */
export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort(
    (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
  )
}

export interface TreeRow {
  path: string
  entry: FileEntry
  depth: number
  expanded: boolean
  /** An expanded folder whose listing has not arrived yet. */
  loading: boolean
}

/** Depth-first visible rows under `root`. `listings` maps a folder path to its
 *  (sorted) entries; `expanded` holds the open folder paths. A folder that is
 *  open but not yet listed renders as loading with no children. */
export function visibleRows(root: string, listings: Map<string, FileEntry[]>, expanded: Set<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (dir: string, depth: number) => {
    for (const entry of listings.get(dir) || []) {
      const path = joinPath(dir, entry.name)
      const open = entry.dir && expanded.has(path)
      rows.push({ path, entry, depth, expanded: open, loading: open && !listings.has(path) })
      if (open) walk(path, depth + 1)
    }
  }
  walk(root, 0)
  return rows
}

/** Text files worth showing in the preview: by extension, or a known dotfile/name. */
const TEXT_EXT = new Set([
  "txt", "md", "markdown", "mdx", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "env", "xml", "html", "htm", "css", "scss", "less", "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "rb", "go", "rs",
  "c", "h", "cpp", "hpp", "cc", "java", "kt", "swift", "php", "sh", "bash", "zsh", "fish", "sql", "lua", "r", "pl",
  "vue", "svelte", "graphql", "proto", "gradle", "properties", "gitignore", "dockerignore", "editorconfig", "lock",
])
const TEXT_NAMES = new Set(["Makefile", "Dockerfile", "LICENSE", "README", "Procfile", "Gemfile", "Rakefile"])
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"])

/** Largest file the preview will fetch; bigger ones are downloaded instead. */
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024

export type PreviewKind = "text" | "image" | "pdf" | "none"

/** How the preview can show a file, from its name and size alone. */
export function previewKind(entry: FileEntry): PreviewKind {
  if (entry.dir || entry.size > PREVIEW_MAX_BYTES) return "none"
  const dot = entry.name.lastIndexOf(".")
  const ext = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : dot === 0 ? entry.name.slice(1).toLowerCase() : ""
  if (IMAGE_EXT.has(ext)) return "image"
  if (ext === "pdf") return "pdf"
  if (TEXT_EXT.has(ext) || TEXT_NAMES.has(entry.name)) return "text"
  return "none"
}

/** True when the bytes look binary (a NUL in the first 8 KB), so a misnamed
 *  binary never renders as mojibake. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}
