import { useEffect, useState } from "react"
import { Loader2, Download, Copy, Check, Eye, Code2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Markdown } from "@/components/Markdown"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { fmtBytes } from "@/lib/format"
import { fetchAndSave } from "@/lib/download"
import { userError } from "@/lib/errors"
import { codeLanguage, HAS_SOURCE_VIEW, isolatedDocument, looksBinary, previewKind, type TreeRow } from "@/lib/fileTree"

const MIME: Record<string, string> = { svg: "image/svg+xml", pdf: "application/pdf" }

/** Readable defaults for a converted Word document inside its isolated frame. */
const DOCX_CSS =
  "body{font:15px/1.6 system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:2rem;color:#1f2328;background:#fff}" +
  "img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:.3rem .5rem}"

type Loaded =
  | { kind: "text"; text: string }
  | { kind: "url"; url: string }
  | { kind: "html"; html: string }
  | { kind: "none"; reason: string }

/** Read-only preview of one file, rendered the way an editor would show it:
 *  Markdown and HTML rendered (with a Code view), code highlighted with line
 *  numbers, images, PDFs and Word documents drawn as documents. Anything else
 *  offers Download. */
export function FilePreview({ row, onClose }: { row: TreeRow; onClose: () => void }) {
  const kind = previewKind(row.entry)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [source, setSource] = useState(false) // Code view of a rendered kind
  const href = api.fsDownload(row.path)

  useEffect(() => {
    if (kind === "none") {
      setLoaded({ kind: "none", reason: row.entry.size > 0 ? "No preview for this file type or size." : "This file is empty." })
      return
    }
    let url = ""
    let live = true
    ;(async () => {
      try {
        const res = await api.getRes(href)
        if (!res.ok) {
          const d = await res.json().catch(() => null)
          throw Object.assign(new Error(d?.error || `HTTP ${res.status}`), { status: res.status })
        }
        const buf = await res.arrayBuffer()
        if (!live) return
        if (kind === "docx") {
          const mammoth = (await import("mammoth")).default
          const { value } = await mammoth.convertToHtml({ arrayBuffer: buf })
          if (live) setLoaded({ kind: "html", html: value })
        } else if (kind === "image" || kind === "pdf") {
          const ext = row.entry.name.split(".").pop()?.toLowerCase() || ""
          url = URL.createObjectURL(new Blob([buf], { type: MIME[ext] || res.headers.get("content-type") || "" }))
          setLoaded({ kind: "url", url })
        } else {
          const bytes = new Uint8Array(buf)
          if (looksBinary(bytes)) setLoaded({ kind: "none", reason: "This looks like a binary file." })
          else setLoaded({ kind: "text", text: new TextDecoder().decode(bytes) })
        }
      } catch (e) {
        if (live) setError(userError(e, "this file"))
      }
    })()
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [href, kind, row.entry])

  const download = () => fetchAndSave(href, row.entry.name, (h) => api.getRes(h)).catch((e) => setError(userError(e, "this file", "download")))
  const toggle = HAS_SOURCE_VIEW.has(kind) && loaded?.kind === "text"

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-3 overflow-hidden sm:max-w-4xl">
        <DialogHeader className="min-w-0">
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-6">
            <span className="truncate">{row.entry.name}</span>
          </DialogTitle>
          <div className="flex min-w-0 items-center gap-1">
            <DialogDescription className="flex min-w-0 items-center gap-2 text-xs">
              <span className="truncate font-mono" title={row.path}>{row.path}</span>
              <span className="shrink-0">· {fmtBytes(row.entry.size)}</span>
            </DialogDescription>
            <Button
              size="icon"
              variant="ghost"
              className="size-6 shrink-0"
              title={copied ? "Copied" : "Copy path"}
              aria-label="Copy path"
              onClick={() => navigator.clipboard?.writeText(row.path).then(() => setCopied(true), () => {})}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-6 shrink-0"
              title="Download"
              aria-label="Download"
              onClick={download}
            >
              <Download className="size-3.5" />
            </Button>
            <span className="flex-1" />
            {toggle && (
              <div className="flex shrink-0 rounded-md border border-border p-0.5" role="group" aria-label="View">
                {([[false, Eye, "Preview"], [true, Code2, "Code"]] as const).map(([v, Icon, label]) => (
                  <button
                    key={label}
                    className={cn(
                      "flex h-6 items-center gap-1 rounded px-2 text-xs transition-colors",
                      source === v ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                    aria-pressed={source === v}
                    onClick={() => setSource(v)}
                  >
                    <Icon className="size-3.5" /> {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/30">
          {error ? (
            <div className="p-4 text-sm text-destructive">{error}</div>
          ) : !loaded ? (
            <Spinner />
          ) : loaded.kind === "text" ? (
            kind === "markdown" && !source ? (
              <div className="p-5">
                <Markdown text={loaded.text} />
              </div>
            ) : kind === "html" && !source ? (
              <Frame title={row.entry.name} html={isolatedDocument(loaded.text)} />
            ) : (
              <CodeView text={loaded.text} name={row.entry.name} />
            )
          ) : loaded.kind === "html" ? (
            <Frame title={row.entry.name} html={isolatedDocument(loaded.html, DOCX_CSS)} />
          ) : loaded.kind === "url" && kind === "pdf" ? (
            <iframe src={loaded.url} title={row.entry.name} className="h-[70vh] w-full" />
          ) : loaded.kind === "url" ? (
            <div className="flex justify-center p-3">
              <img src={loaded.url} alt={row.entry.name} className="max-h-[70vh] max-w-full object-contain" />
            </div>
          ) : (
            <div className="p-4 text-sm text-muted-foreground">{loaded.reason}</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Spinner() {
  return (
    <div className="flex items-center gap-1.5 p-4 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> loading…
    </div>
  )
}

/** Untrusted HTML in a frame with no scripts, no same-origin and no network. */
function Frame({ title, html }: { title: string; html: string }) {
  return <iframe sandbox="" srcDoc={html} title={title} className="h-[70vh] w-full bg-white" />
}

/** Source with a line-number gutter, highlighted once the highlighter loads
 *  (plain text until then, and for languages it does not know). */
function CodeView({ text, name }: { text: string; name: string }) {
  const lang = codeLanguage(name)
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    setHtml(null)
    if (!lang) return
    let live = true
    import("@/lib/highlight").then((m) => live && setHtml(m.highlight(text, lang)), () => {})
    return () => {
      live = false
    }
  }, [text, lang])
  const lines = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length
  return (
    <div className="flex min-w-max font-mono text-xs leading-relaxed">
      <pre aria-hidden className="sticky left-0 select-none border-r border-border bg-muted/60 px-3 py-3 text-right text-muted-foreground/70">
        {Array.from({ length: Math.max(lines, 1) }, (_, i) => i + 1).join("\n")}
      </pre>
      {html === null ? (
        <pre className="whitespace-pre px-4 py-3">{text}</pre>
      ) : (
        <pre className="hljs whitespace-pre px-4 py-3" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  )
}
