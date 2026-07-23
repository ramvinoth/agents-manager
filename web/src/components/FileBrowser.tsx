import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  Folder,
  File as FileIcon,
  FileText,
  FileCode,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  ChevronRight,
  ArrowUp,
  Home,
  FolderPlus,
  Upload,
  RefreshCw,
  Eye,
  EyeOff,
  X,
  Loader2,
  Download,
  Pencil,
  Trash2,
  FolderOpen,
  Check,
  FileArchive as Compress,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { fmtBytes, fmtAgo } from "@/lib/format"
import { describeHost } from "@/lib/host"
import { api } from "@/lib/api"
import { useStore } from "@/store"
import type { FileEntry, FileListResponse } from "@/lib/types"

// ---- file-type → icon + accent color ---------------------------------------
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

function iconFor(entry: FileEntry) {
  if (entry.dir) return { Icon: Folder, color: "text-sky-500" }
  const ext = entry.name.split(".").pop()?.toLowerCase() || ""
  return EXT[ext] || { Icon: FileIcon, color: "text-muted-foreground" }
}

const joinPath = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : dir + "/" + name)

type Menu = { x: number; y: number; entry: FileEntry | null }

export function FileBrowser() {
  const closeFs = useStore((s) => s.closeFs)
  const fsPick = useStore((s) => s.fsPick)
  const currentHost = useStore((s) => s.currentHost)
  const hosts = useStore((s) => s.hosts)
  const hostLabel = describeHost(currentHost, hosts)

  const [path, setPath] = useState("~")
  const [data, setData] = useState<FileListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showHidden, setShowHidden] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // upload/compress in flight
  const [status, setStatus] = useState<string | null>(null)
  const [marquee, setMarquee] = useState<{ l: number; t: number; w: number; h: number } | null>(null)
  const dragDepth = useRef(0)
  const lastIdx = useRef<number | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(
    async (p: string) => {
      setLoading(true)
      setError(null)
      setSelected(new Set())
      setMenu(null)
      lastIdx.current = null
      try {
        const d = (await api.fs(p, showHidden)) as FileListResponse & { error?: string }
        if (d.error) throw new Error(d.error)
        setData(d)
        setPath(d.path)
      } catch (e: any) {
        setError(e?.message || String(e))
      }
      setLoading(false)
    },
    [showHidden]
  )

  useEffect(() => {
    load(path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (menu) setMenu(null)
        else if (!renaming && !creating) closeFs()
      }
    }
    const onClick = () => setMenu(null)
    window.addEventListener("keydown", onKey)
    window.addEventListener("click", onClick)
    window.addEventListener("resize", onClick)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("click", onClick)
      window.removeEventListener("resize", onClick)
    }
  }, [menu, renaming, creating, closeFs])

  function flash(msg: string) {
    setStatus(msg)
    setTimeout(() => setStatus((s) => (s === msg ? null : s)), 3500)
  }

  function triggerDownload(href: string, filename: string) {
    const a = document.createElement("a")
    a.href = href
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  function download(entry: FileEntry) {
    triggerDownload(api.fsDownload(joinPath(path, entry.name)), entry.name)
  }

  function downloadZip(names: string[]) {
    if (!names.length) return
    const arc = names.length === 1 ? names[0] + ".zip" : "Archive.zip"
    triggerDownload(api.fsDownloadZip(path, names), arc)
  }

  function openEntry(entry: FileEntry) {
    if (entry.dir) load(joinPath(path, entry.name))
    else download(entry)
  }

  async function doUpload(files: File[]) {
    if (!files.length) return
    setBusy("Uploading…")
    try {
      const res = await api.fsUpload(path, files)
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      const failed = (d.uploaded || []).filter((u: any) => u.error)
      flash(failed.length ? `Uploaded with ${failed.length} error(s)` : `Uploaded ${files.length} item(s)`)
      await load(path)
    } catch (e: any) {
      setError(e?.message || String(e))
    }
    setBusy(null)
  }

  async function createFolder() {
    const name = newName.trim()
    setCreating(false)
    setNewName("")
    if (!name) return
    try {
      const res = await api.fsMkdir({ path, name })
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      await load(path)
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  async function commitRename(entry: FileEntry, value: string) {
    setRenaming(null)
    const name = value.trim()
    if (!name || name === entry.name) return
    try {
      const res = await api.fsRename({ path: joinPath(path, entry.name), name })
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      await load(path)
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  async function trashMany(names: string[]) {
    try {
      for (const n of names) {
        const res = await api.fsDelete({ path: joinPath(path, n) })
        const d = await res.json()
        if (d.error) throw new Error(d.error)
      }
      flash(names.length === 1 ? `Moved “${names[0]}” to Trash` : `Moved ${names.length} items to Trash`)
      await load(path)
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  async function compress(names: string[]) {
    if (!names.length) return
    setBusy("Compressing…")
    try {
      const res = await api.fsCompress({ path, names })
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      flash(`Compressed ${names.length} item${names.length === 1 ? "" : "s"} → ${d.created.split("/").pop()}`)
      await load(path)
    } catch (e: any) {
      setError(e?.message || String(e))
    }
    setBusy(null)
  }

  const entries = data?.entries
    ? [...data.entries].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    : []
  const segs = (data?.path || "").split("/").filter(Boolean)

  // ---- selection -----------------------------------------------------------
  function clickSelect(entry: FileEntry, idx: number, e: React.MouseEvent) {
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const n = new Set(prev)
        n.has(entry.name) ? n.delete(entry.name) : n.add(entry.name)
        return n
      })
      lastIdx.current = idx
    } else if (e.shiftKey && lastIdx.current != null) {
      const [a, b] = [Math.min(lastIdx.current, idx), Math.max(lastIdx.current, idx)]
      setSelected(new Set(entries.slice(a, b + 1).map((x) => x.name)))
    } else {
      setSelected(new Set([entry.name]))
      lastIdx.current = idx
    }
  }

  // Marquee (rubber-band) selection when dragging from empty space.
  function onBodyMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return
    const el = e.target as HTMLElement
    if (el.closest("[data-name]") || el.closest("[data-nomarquee]")) return
    const startX = e.clientX
    const startY = e.clientY
    let moved = false
    const move = (ev: MouseEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) return
      moved = true
      const l = Math.min(startX, ev.clientX)
      const t = Math.min(startY, ev.clientY)
      const r = Math.max(startX, ev.clientX)
      const b = Math.max(startY, ev.clientY)
      setMarquee({ l, t, w: r - l, h: b - t })
      const names = new Set<string>()
      bodyRef.current?.querySelectorAll<HTMLElement>("[data-name]").forEach((node) => {
        const rr = node.getBoundingClientRect()
        if (!(rr.right < l || rr.left > r || rr.bottom < t || rr.top > b)) names.add(node.dataset.name!)
      })
      setSelected(names)
    }
    const up = () => {
      window.removeEventListener("mousemove", move)
      window.removeEventListener("mouseup", up)
      setMarquee(null)
      if (!moved) setSelected(new Set()) // plain click on empty space clears
    }
    window.addEventListener("mousemove", move)
    window.addEventListener("mouseup", up)
  }

  const selNames = [...selected]
  const multi = selNames.length > 1

  return createPortal(
    <div
      className={cn(
        "pointer-events-auto fixed inset-0 flex items-center justify-center p-4",
        fsPick ? "z-[60]" : "z-50"
      )}
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={closeFs} />

      <div
        className="relative flex h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onDragEnter={(e) => {
          e.preventDefault()
          dragDepth.current++
          if (e.dataTransfer.types.includes("Files")) setDragOver(true)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault()
          dragDepth.current--
          if (dragDepth.current <= 0) setDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          dragDepth.current = 0
          setDragOver(false)
          const files = Array.from(e.dataTransfer.files)
          if (files.length) doUpload(files)
        }}
      >
        {/* Title bar */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2" data-nomarquee>
          <FolderOpen className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">{fsPick ? "Pick a folder" : "Files"}</span>
          <span className="truncate text-xs text-muted-foreground">· {hostLabel}</span>
          {fsPick && (
            <Button
              size="sm"
              className="ml-auto h-7 gap-1"
              onClick={() => {
                fsPick(path)
                closeFs()
              }}
              title={`Use ${path}`}
            >
              <Check className="size-3.5" /> Use this folder
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-7", !fsPick && "ml-auto")}
            onClick={closeFs}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5" data-nomarquee>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            disabled={!data?.parent}
            onClick={() => data?.parent && load(data.parent)}
            title="Up"
          >
            <ArrowUp className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-7" onClick={() => load("~")} title="Home">
            <Home className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-7" onClick={() => load(path)} title="Refresh">
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>

          <div className="mx-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap text-xs">
            <button
              onClick={() => load("/")}
              className="rounded px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              /
            </button>
            {segs.map((s, i) => (
              <span key={i} className="flex items-center gap-0.5">
                <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
                <button
                  onClick={() => load("/" + segs.slice(0, i + 1).join("/"))}
                  className={cn(
                    "rounded px-1 py-0.5 hover:bg-accent",
                    i === segs.length - 1 ? "font-medium text-foreground" : "text-muted-foreground"
                  )}
                >
                  {s}
                </button>
              </span>
            ))}
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setShowHidden((v) => !v)}
            title={showHidden ? "Hide dotfiles" : "Show dotfiles"}
          >
            {showHidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => {
              setCreating(true)
              setNewName("")
            }}
          >
            <FolderPlus className="size-3.5" /> New Folder
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => fileInput.current?.click()}
          >
            <Upload className="size-3.5" /> Upload
          </Button>
        </div>

        {/* Body */}
        <div
          ref={bodyRef}
          className="relative min-h-0 flex-1 select-none overflow-y-auto"
          onMouseDown={onBodyMouseDown}
          onContextMenu={(e) => {
            e.preventDefault()
            setSelected(new Set())
            setMenu({ x: e.clientX, y: e.clientY, entry: null })
          }}
        >
          {loading ? (
            <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : error ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-destructive">
              {error}
              <Button size="sm" variant="outline" onClick={() => load(path)}>
                Retry
              </Button>
            </div>
          ) : entries.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              This folder is empty
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1 p-3">
              {entries.map((entry, idx) => {
                const { Icon, color } = iconFor(entry)
                const isSel = selected.has(entry.name)
                return (
                  <button
                    key={entry.name}
                    data-name={entry.name}
                    onClick={(e) => {
                      e.stopPropagation()
                      clickSelect(entry, idx, e)
                    }}
                    onDoubleClick={() => openEntry(entry)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      if (!selected.has(entry.name)) {
                        setSelected(new Set([entry.name]))
                        lastIdx.current = idx
                      }
                      setMenu({ x: e.clientX, y: e.clientY, entry })
                    }}
                    title={`${entry.name}${entry.dir ? "" : " · " + fmtBytes(entry.size)} · ${fmtAgo(entry.mtime)}`}
                    className={cn(
                      "group flex flex-col items-center gap-1.5 rounded-lg px-1 py-2.5 text-center transition-colors",
                      isSel ? "bg-primary/15 ring-1 ring-primary/40" : "hover:bg-accent"
                    )}
                  >
                    <Icon className={cn("size-11", color)} strokeWidth={1.5} />
                    {renaming === entry.name ? (
                      <input
                        autoFocus
                        defaultValue={entry.name}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(entry, (e.target as HTMLInputElement).value)
                          if (e.key === "Escape") setRenaming(null)
                        }}
                        onBlur={(e) => commitRename(entry, e.target.value)}
                        className="w-full rounded border border-primary bg-background px-1 text-center text-xs outline-none"
                      />
                    ) : (
                      <span className="line-clamp-2 w-full break-words text-xs leading-tight">
                        {entry.name}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}

          {dragOver && (
            <div className="pointer-events-none absolute inset-0 z-10 m-2 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary bg-primary/10 text-sm font-medium text-primary">
              <Upload className="size-6" />
              Drop to upload to {segs[segs.length - 1] || "/"}
            </div>
          )}
        </div>

        {/* Status bar */}
        <div className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-xs text-muted-foreground" data-nomarquee>
          {busy ? (
            <span className="flex items-center gap-1.5 text-foreground">
              <Loader2 className="size-3.5 animate-spin" /> {busy}
            </span>
          ) : status ? (
            <span className="text-foreground">{status}</span>
          ) : multi ? (
            <span className="text-foreground">{selNames.length} items selected</span>
          ) : selNames.length === 1 ? (
            (() => {
              const e = entries.find((x) => x.name === selNames[0])
              return e ? (
                <span className="truncate">
                  {e.name}
                  {!e.dir && ` · ${fmtBytes(e.size)}`} · {fmtAgo(e.mtime)}
                </span>
              ) : null
            })()
          ) : (
            <span>
              {entries.length} item{entries.length === 1 ? "" : "s"}
              {data?.truncated && " · showing first 800"}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            <span className="hidden truncate sm:inline">Drag to select · drop files to upload</span>
          </span>
        </div>

        {/* Context menu */}
        {menu && (
          <div
            className="fixed z-[60] min-w-48 overflow-hidden rounded-md border border-border bg-popover p-1 text-sm shadow-md"
            style={{
              left: Math.min(menu.x, window.innerWidth - 210),
              top: Math.min(menu.y, window.innerHeight - 260),
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {menu.entry ? (
              multi ? (
                <>
                  <MenuItem icon={Compress} onClick={() => { compress(selNames); setMenu(null) }}>
                    Compress {selNames.length} items
                  </MenuItem>
                  <MenuItem icon={Download} onClick={() => { downloadZip(selNames); setMenu(null) }}>
                    Download as Zip
                  </MenuItem>
                  <div className="my-1 h-px bg-border" />
                  <MenuItem icon={Trash2} danger onClick={() => { trashMany(selNames); setMenu(null) }}>
                    Move {selNames.length} items to Trash
                  </MenuItem>
                </>
              ) : (
                <>
                  <MenuItem icon={menu.entry.dir ? FolderOpen : Eye} onClick={() => { openEntry(menu.entry!); setMenu(null) }}>
                    Open
                  </MenuItem>
                  {menu.entry.dir ? (
                    <MenuItem icon={Download} onClick={() => { downloadZip([menu.entry!.name]); setMenu(null) }}>
                      Download as Zip
                    </MenuItem>
                  ) : (
                    <MenuItem icon={Download} onClick={() => { download(menu.entry!); setMenu(null) }}>
                      Download
                    </MenuItem>
                  )}
                  <MenuItem icon={Compress} onClick={() => { compress([menu.entry!.name]); setMenu(null) }}>
                    Compress
                  </MenuItem>
                  <MenuItem icon={Pencil} onClick={() => { setRenaming(menu.entry!.name); setMenu(null) }}>
                    Rename
                  </MenuItem>
                  <div className="my-1 h-px bg-border" />
                  <MenuItem icon={Trash2} danger onClick={() => { trashMany([menu.entry!.name]); setMenu(null) }}>
                    Move to Trash
                  </MenuItem>
                </>
              )
            ) : (
              <>
                <MenuItem icon={FolderPlus} onClick={() => { setCreating(true); setNewName(""); setMenu(null) }}>
                  New Folder
                </MenuItem>
                <MenuItem icon={Upload} onClick={() => { fileInput.current?.click(); setMenu(null) }}>
                  Upload…
                </MenuItem>
                <div className="my-1 h-px bg-border" />
                <MenuItem icon={RefreshCw} onClick={() => { load(path); setMenu(null) }}>
                  Refresh
                </MenuItem>
              </>
            )}
          </div>
        )}

        {/* Marquee rectangle */}
        {marquee && (
          <div
            className="pointer-events-none fixed z-[55] rounded-sm border border-primary/70 bg-primary/15"
            style={{ left: marquee.l, top: marquee.t, width: marquee.w, height: marquee.h }}
          />
        )}

        {/* New-folder inline prompt */}
        {creating && (
          <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/30" onClick={() => setCreating(false)}>
            <div className="w-72 rounded-lg border border-border bg-popover p-3 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                <FolderPlus className="size-4 text-muted-foreground" /> New folder
              </div>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createFolder()
                  if (e.key === "Escape") setCreating(false)
                }}
                placeholder="Folder name"
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <div className="mt-3 flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={createFolder} disabled={!newName.trim()}>
                  Create
                </Button>
              </div>
            </div>
          </div>
        )}

        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files || [])
            e.target.value = ""
            if (files.length) doUpload(files)
          }}
        />
      </div>
    </div>,
    document.body
  )
}

function MenuItem({
  icon: Icon,
  children,
  onClick,
  danger,
}: {
  icon: typeof FileIcon
  children: React.ReactNode
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent",
        danger ? "text-destructive" : ""
      )}
    >
      <Icon className="size-3.5" /> {children}
    </button>
  )
}
