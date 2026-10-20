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
const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"])

/** Largest text file the preview will fetch; bigger ones are downloaded instead. */
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024
/** Documents (images, Word) render whole, so they may be larger than text. */
export const DOC_PREVIEW_MAX_BYTES = 25 * 1024 * 1024
/** A PDF has no size cap: the browser's viewer streams it from the server
 *  with range requests. Only a PDF this big on a remote host (whose leg sends
 *  the whole file) waits for a tap instead of loading on open. */
export const PDF_AUTOLOAD_MAX_BYTES = DOC_PREVIEW_MAX_BYTES

export type PreviewKind = "markdown" | "html" | "code" | "image" | "pdf" | "docx" | "none"

/** Kinds that show rendered by default with a Code toggle for the source. */
export const HAS_SOURCE_VIEW: ReadonlySet<PreviewKind> = new Set(["markdown", "html"])

/** Lower-cased extension; a dotfile's name is its extension (".gitignore" → "gitignore"). */
function extOf(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : dot === 0 ? name.slice(1).toLowerCase() : ""
}

/** How the preview can show a file, from its name and size alone. "code" is
 *  any other text file: highlighted when codeLanguage knows it, plain if not. */
export function previewKind(entry: FileEntry): PreviewKind {
  if (entry.dir) return "none"
  const ext = extOf(entry.name)
  if (ext === "pdf") return "pdf"
  const doc = IMAGE_EXT.has(ext) ? "image" : ext === "docx" ? "docx" : null
  if (doc) return entry.size > DOC_PREVIEW_MAX_BYTES ? "none" : doc
  if (entry.size > PREVIEW_MAX_BYTES) return "none"
  if (MARKDOWN_EXT.has(ext)) return "markdown"
  if (ext === "html" || ext === "htm") return "html"
  if (TEXT_EXT.has(ext) || TEXT_NAMES.has(entry.name)) return "code"
  return "none"
}

/** Extensions whose highlight.js language id differs from the extension. */
const LANG_ALIAS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", rs: "rust", kt: "kotlin", pl: "perl", h: "c", hpp: "cpp", cc: "cpp",
  sh: "bash", zsh: "bash", fish: "bash", yml: "yaml", jsonl: "json",
  html: "xml", htm: "xml", vue: "xml", svelte: "xml", svg: "xml",
  toml: "ini", cfg: "ini", conf: "ini", env: "ini", properties: "ini", editorconfig: "ini",
  md: "markdown", markdown: "markdown", mdx: "markdown",
}
/** Languages the preview's highlighter registers (lib/highlight.ts). */
export const HIGHLIGHT_LANGS = [
  "bash", "c", "cpp", "css", "dockerfile", "go", "graphql", "ini", "java", "javascript", "json", "kotlin", "less",
  "lua", "makefile", "markdown", "perl", "php", "python", "r", "ruby", "rust", "scss", "sql", "swift", "typescript",
  "xml", "yaml",
] as const
export type HighlightLang = (typeof HIGHLIGHT_LANGS)[number]
const KNOWN = new Set<string>(HIGHLIGHT_LANGS)
const NAME_LANG: Record<string, string> = { Dockerfile: "dockerfile", Makefile: "makefile", Gemfile: "ruby", Rakefile: "ruby" }

/** The highlight.js language for a file name, or null to show it as plain text. */
export function codeLanguage(name: string): HighlightLang | null {
  const lang = NAME_LANG[name] || LANG_ALIAS[extOf(name)] || extOf(name)
  return KNOWN.has(lang) ? (lang as HighlightLang) : null
}

/** True when the bytes look binary (a NUL in the first 8 KB), so a misnamed
 *  binary never renders as mojibake. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

/** Untrusted HTML (an .html file, a converted Word document) as an iframe
 *  srcdoc that cannot run scripts or reach the network: a CSP meta goes first
 *  so the parser puts it in <head> before anything else loads. Pair with
 *  sandbox="" on the iframe. */
export function isolatedDocument(html: string, css = ""): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:">`
  return csp + (css ? `<style>${css}</style>` : "") + html
}
