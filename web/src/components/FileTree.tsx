import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronRight, ChevronDown, ChevronsDownUp, RefreshCw, Eye, EyeOff, Loader2, Download, Copy, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { fmtBytes } from "@/lib/format"
import { fetchAndSave } from "@/lib/download"
import { userError } from "@/lib/errors"
import { START_PATH } from "@/lib/location"
import { looksBinary, previewKind, sortEntries, visibleRows, type TreeRow } from "@/lib/fileTree"
import type { FileEntry, FileListResponse } from "@/lib/types"
import { iconFor } from "@/components/fileIcons"
import { useStore } from "@/store"

const INDENT = 12 // px per level, like VS Code's explorer

/** Open folders persist per host + root, so a reload keeps the tree as it was. */
const openKey = (host: string, root: string) => `filesOpen:${host}:${root}`
function readOpen(host: string, root: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(openKey(host, root)) || "[]")
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : [])
  } catch {
    return new Set()
  }
}

/**
 * The Files tab: a VS Code-style explorer of the drilled-in project's folder
 * (the home folder when no project is open), on the current host. Folders load
 * lazily on expand; a file opens a read-only preview. Managing files (upload,
 * rename, delete) stays in Tools → Files.
 */
export function FileTree() {
  const currentHost = useStore((s) => s.currentHost)
  const project = useStore((s) => s.projectDirs[s.currentHost] ?? "")
  const start = project || START_PATH

  const [root, setRoot] = useState("") // resolved path of `start` (~ expands server-side)
  const [listings, setListings] = useState<Map<string, FileEntry[]>>(new Map())
  const [errors, setErrors] = useState<Map<string, string>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showHidden, setShowHidden] = useState(() => localStorage.getItem("filesHidden") === "1")
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<TreeRow | null>(null)
  const [rootError, setRootError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const treeRef = useRef<HTMLDivElement>(null)
  // A listing that lands after the root or hidden flag changed belongs to the old tree.
  const gen = useRef(0)

  const list = useCallback(
    async (path: string, g: number) => {
      try {
        const d = (await api.fs(path, showHidden)) as FileListResponse & { error?: string }
        if (d.error) throw new Error(d.error)
        if (g !== gen.current) return null
        const entries = sortEntries(d.entries)
        setListings((m) => new Map(m).set(path, entries))
        setErrors((m) => {
          if (!m.has(path)) return m
          const n = new Map(m)
          n.delete(path)
          return n
        })
        return d
      } catch (e) {
        if (g !== gen.current) return null
        // Listed as empty so the folder stops spinning; the error shows in its place.
        setListings((m) => new Map(m).set(path, []))
        setErrors((m) => new Map(m).set(path, userError(e, "this folder")))
        return null
      }
    },
    [showHidden]
  )

  // (Re)build the tree: list the root, then every folder left open last time.
  const reload = useCallback(async () => {
    const g = ++gen.current
    setRefreshing(true)
    setRootError(null)
    setListings(new Map())
    setErrors(new Map())
    try {
      const d = (await api.fs(start, showHidden)) as FileListResponse & { error?: string }
      if (d.error) throw new Error(d.error)
      if (g !== gen.current) return
      const open = readOpen(currentHost, d.path)
      setRoot(d.path)
      setExpanded(open)
      setListings(new Map([[d.path, sortEntries(d.entries)]]))
      await Promise.all([...open].map((p) => list(p, g)))
    } catch (e) {
      if (g === gen.current) setRootError(userError(e, "this folder"))
    } finally {
      if (g === gen.current) setRefreshing(false)
    }
  }, [start, showHidden, currentHost, list])

  useEffect(() => {
    reload()
  }, [reload])

  const saveOpen = (next: Set<string>) => {
    setExpanded(next)
    if (root) localStorage.setItem(openKey(currentHost, root), JSON.stringify([...next]))
  }

  const toggleFolder = (path: string) => {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else {
      next.add(path)
      if (!listings.has(path)) list(path, gen.current)
    }
    saveOpen(next)
  }

  const rows = useMemo(() => (root ? visibleRows(root, listings, expanded) : []), [root, listings, expanded])

  const activate = (r: TreeRow) => {
    setSelected(r.path)
    if (r.entry.dir) toggleFolder(r.path)
    else setPreview(r)
  }

  // Arrow keys move the selection; Right/Left open/close a folder, Enter opens.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = rows.findIndex((r) => r.path === selected)
    const r = rows[i]
    const go = (j: number) => {
      const t = rows[Math.max(0, Math.min(rows.length - 1, j))]
      if (!t) return
      setSelected(t.path)
      treeRef.current?.querySelector(`[data-path="${CSS.escape(t.path)}"]`)?.scrollIntoView({ block: "nearest" })
    }
    if (e.key === "ArrowDown") go(i + 1)
    else if (e.key === "ArrowUp") go(i < 0 ? 0 : i - 1)
    else if (e.key === "ArrowRight" && r?.entry.dir) {
      if (!r.expanded) toggleFolder(r.path)
      else go(i + 1)
    } else if (e.key === "ArrowLeft" && r) {
      if (r.entry.dir && r.expanded) toggleFolder(r.path)
      else {
        // To the parent folder's row.
        for (let j = i - 1; j >= 0; j--) if (rows[j].depth < r.depth) return go(j)
      }
    } else if (e.key === "Enter" && r) activate(r)
    else return
    e.preventDefault()
  }

  const rootName = root.split("/").filter(Boolean).pop() || root || "…"

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" title={root}>
          {rootName}
        </span>
        <Button variant="ghost" size="icon" className="size-6" onClick={reload} aria-label="Refresh" title="Refresh">
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => saveOpen(new Set())}
          aria-label="Collapse folders"
          title="Collapse folders"
        >
          <ChevronsDownUp className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-6", showHidden && "bg-accent")}
          onClick={() => {
            localStorage.setItem("filesHidden", showHidden ? "0" : "1")
            setShowHidden(!showHidden)
          }}
          aria-pressed={showHidden}
          aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
          title={showHidden ? "Hide hidden files" : "Show hidden files"}
        >
          {showHidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
        </Button>
      </div>
      <div
        ref={treeRef}
        role="tree"
        aria-label="Files"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-auto py-1 text-[13px] outline-none"
      >
        {rootError ? (
          <div className="px-3 py-2 text-xs text-destructive">{rootError}</div>
        ) : !root ? (
          <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">This folder is empty.</div>
        ) : (
          rows.map((r) => (
            <TreeItem
              key={r.path}
              row={r}
              selected={r.path === selected}
              error={errors.get(r.path)}
              empty={r.expanded && !r.loading && !errors.has(r.path) && !listings.get(r.path)?.length}
              onClick={() => activate(r)}
            />
          ))
        )}
      </div>
      {preview && <FilePreview row={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}

function TreeItem({
  row,
  selected,
  error,
  empty,
  onClick,
}: {
  row: TreeRow
  selected: boolean
  error?: string
  empty: boolean
  onClick: () => void
}) {
  const { entry, depth } = row
  const { Icon, color } = iconFor(entry)
  const pad = 6 + depth * INDENT
  return (
    <>
      <div
        role="treeitem"
        aria-expanded={entry.dir ? row.expanded : undefined}
        aria-selected={selected}
        data-path={row.path}
        onClick={onClick}
        title={row.path}
        style={{ paddingLeft: pad }}
        className={cn(
          "relative flex h-[22px] cursor-pointer select-none items-center gap-1 pr-2 hover:bg-accent/60",
          selected && "bg-accent text-accent-foreground"
        )}
      >
        {/* Indent guides, one per ancestor level. */}
        {Array.from({ length: depth }, (_, i) => (
          <span key={i} className="absolute inset-y-0 w-px bg-border" style={{ left: 6 + i * INDENT + 7 }} />
        ))}
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {entry.dir &&
            (row.loading ? (
              <Loader2 className="size-3 animate-spin" />
            ) : row.expanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            ))}
        </span>
        <Icon className={cn("size-4 shrink-0", color)} />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </div>
      {(error || empty) && (
        <div
          className={cn("truncate py-0.5 pr-2 text-[11px] italic", error ? "text-destructive" : "text-muted-foreground")}
          style={{ paddingLeft: pad + INDENT + 20 }}
          title={error}
        >
          {error || "empty"}
        </div>
      )}
    </>
  )
}

const MIME: Record<string, string> = { svg: "image/svg+xml", pdf: "application/pdf" }

type Loaded = { kind: "text"; text: string } | { kind: "url"; url: string } | { kind: "none"; reason: string }

/** Read-only preview of one file: text, image or PDF; anything else offers Download. */
function FilePreview({ row, onClose }: { row: TreeRow; onClose: () => void }) {
  const kind = previewKind(row.entry)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
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
        if (kind === "text") {
          const bytes = new Uint8Array(buf)
          if (looksBinary(bytes)) setLoaded({ kind: "none", reason: "This looks like a binary file." })
          else setLoaded({ kind: "text", text: new TextDecoder().decode(bytes) })
        } else {
          const ext = row.entry.name.split(".").pop()?.toLowerCase() || ""
          url = URL.createObjectURL(new Blob([buf], { type: MIME[ext] || res.headers.get("content-type") || "" }))
          setLoaded({ kind: "url", url })
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

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-3 overflow-hidden sm:max-w-4xl">
        <DialogHeader className="min-w-0">
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-6">
            <span className="truncate">{row.entry.name}</span>
          </DialogTitle>
          <DialogDescription className="flex min-w-0 items-center gap-2 text-xs">
            <span className="truncate font-mono" title={row.path}>{row.path}</span>
            <span className="shrink-0">· {fmtBytes(row.entry.size)}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={download}>
            <Download className="size-3.5" /> Download
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            onClick={() => navigator.clipboard?.writeText(row.path).then(() => setCopied(true), () => {})}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} Copy path
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/30">
          {error ? (
            <div className="p-4 text-sm text-destructive">{error}</div>
          ) : !loaded ? (
            <div className="flex items-center gap-1.5 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> loading…
            </div>
          ) : loaded.kind === "text" ? (
            <pre className="whitespace-pre p-3 font-mono text-xs leading-relaxed">{loaded.text}</pre>
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
