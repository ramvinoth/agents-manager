import { joinPath, sortEntries, visibleRows, previewKind, looksBinary, PREVIEW_MAX_BYTES } from "./fileTree.ts"
import type { FileEntry } from "./types.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}
const F = (name: string, size = 10): FileEntry => ({ name, dir: false, size, mtime: 0 })
const D = (name: string): FileEntry => ({ name, dir: true, size: 0, mtime: 0 })

eq("join plain", joinPath("/a", "b"), "/a/b")
eq("join trailing slash", joinPath("/", "b"), "/b")
eq("sort dirs first, natural, case-insensitive",
  sortEntries([F("file10"), F("File9"), D("zeta"), D("Alpha")]).map((e) => e.name),
  ["Alpha", "zeta", "File9", "file10"])

const listings = new Map<string, FileEntry[]>([
  ["/p", [D("src"), D("docs"), F("README.md")]],
  ["/p/src", [F("a.ts")]],
])
eq("collapsed shows only root level",
  visibleRows("/p", listings, new Set()).map((r) => [r.path, r.depth, r.expanded]),
  [["/p/src", 0, false], ["/p/docs", 0, false], ["/p/README.md", 0, false]])
eq("expanded folder nests its children",
  visibleRows("/p", listings, new Set(["/p/src"])).map((r) => [r.path, r.depth]),
  [["/p/src", 0], ["/p/src/a.ts", 1], ["/p/docs", 0], ["/p/README.md", 0]])
const loading = visibleRows("/p", listings, new Set(["/p/docs"])).find((r) => r.path === "/p/docs")
eq("open but unlisted folder is loading", [loading?.expanded, loading?.loading], [true, true])
eq("expanded state of a file is ignored",
  visibleRows("/p", listings, new Set(["/p/README.md"])).find((r) => r.path === "/p/README.md")?.expanded, false)
eq("missing root yields no rows", visibleRows("/nope", listings, new Set()), [])

eq("ts is text", previewKind(F("a.ts")), "text")
eq("Dockerfile is text", previewKind(F("Dockerfile")), "text")
eq(".gitignore is text", previewKind(F(".gitignore")), "text")
eq("PNG any case is image", previewKind(F("Shot.PNG")), "image")
eq("pdf", previewKind(F("brief.pdf")), "pdf")
eq("unknown binary", previewKind(F("app.exe")), "none")
eq("no extension unknown", previewKind(F("data")), "none")
eq("too big", previewKind(F("big.log", PREVIEW_MAX_BYTES + 1)), "none")
eq("folder", previewKind(D("src")), "none")
eq("binary sniff", [looksBinary(new Uint8Array([104, 0, 105])), looksBinary(new TextEncoder().encode("hi"))], [true, false])

console.log(`fileTree: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
