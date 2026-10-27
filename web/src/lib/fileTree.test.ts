import { joinPath, sortEntries, visibleRows, previewKind, codeLanguage, isolatedDocument, looksBinary, PREVIEW_MAX_BYTES, DOC_PREVIEW_MAX_BYTES } from "./fileTree.ts"
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

eq("ts is code", previewKind(F("a.ts")), "code")
eq("Dockerfile is code", previewKind(F("Dockerfile")), "code")
eq(".gitignore is code", previewKind(F(".gitignore")), "code")
eq("md renders as markdown", previewKind(F("README.md")), "markdown")
eq("MDX any case is markdown", previewKind(F("Doc.MDX")), "markdown")
eq("html renders", previewKind(F("index.htm")), "html")
eq("PNG any case is image", previewKind(F("Shot.PNG")), "image")
eq("pdf", previewKind(F("brief.pdf")), "pdf")
eq("docx", previewKind(F("memo.docx")), "docx")
eq("old binary .doc has no preview", previewKind(F("memo.doc")), "none")
eq("unknown binary", previewKind(F("app.exe")), "none")
eq("no extension unknown", previewKind(F("data")), "none")
eq("text too big", previewKind(F("big.log", PREVIEW_MAX_BYTES + 1)), "none")
eq("pdf may exceed the text cap", previewKind(F("big.pdf", PREVIEW_MAX_BYTES + 1)), "pdf")
eq("document too big", previewKind(F("huge.docx", DOC_PREVIEW_MAX_BYTES + 1)), "none")
eq("a PDF of any size previews (streamed)", previewKind(F("book.pdf", 500 * 1024 * 1024)), "pdf")
eq("folder", previewKind(D("src")), "none")
eq("tsx highlights as typescript", codeLanguage("App.tsx"), "typescript")
eq("py", codeLanguage("server.py"), "python")
eq("ext matching a language id", codeLanguage("main.go"), "go")
eq("yml alias", codeLanguage("ci.YML"), "yaml")
eq("Dockerfile by name", codeLanguage("Dockerfile"), "dockerfile")
eq("dotfile by name", codeLanguage(".editorconfig"), "ini")
eq("unknown text is plain", codeLanguage("notes.txt"), null)
eq("no extension is plain", codeLanguage("LICENSE"), null)
const iso = isolatedDocument("<script>x()</script><p>hi</p>", "p{color:red}")
eq("CSP comes first", iso.startsWith('<meta http-equiv="Content-Security-Policy"'), true)
eq("CSP blocks scripts and network", /default-src 'none'/.test(iso) && !/script-src/.test(iso), true)
eq("css then body kept", iso.endsWith("<style>p{color:red}</style><script>x()</script><p>hi</p>"), true)
eq("binary sniff", [looksBinary(new Uint8Array([104, 0, 105])), looksBinary(new TextEncoder().encode("hi"))], [true, false])

console.log(`fileTree: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
