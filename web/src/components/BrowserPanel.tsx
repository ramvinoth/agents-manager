import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowLeft, ArrowRight, RotateCw, Power, Loader2, X, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useStore } from "@/store"

interface Tab {
  id: string
  title?: string
  url?: string
  active?: boolean
}

export function BrowserPanel({ onState }: { onState?: (s: string) => void }) {
  const imgRef = useRef<HTMLImageElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const downRef = useRef(false)
  const lastMoveRef = useRef(0)
  const [status, setStatus] = useState<any>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [url, setUrl] = useState("")
  const [tabs, setTabs] = useState<Tab[]>([])
  const [mcpNote, setMcpNote] = useState<string | null>(null)
  const [mcpConfirm, setMcpConfirm] = useState(false)
  const urlFocused = useRef(false)
  const loadCapabilities = useStore((s) => s.loadCapabilities)

  const browserOp = useCallback(async (op: string, body: Record<string, unknown> = {}) => {
    try {
      return await (await api.browserOp(op, body)).json()
    } catch (e: any) {
      return { error: e.message }
    }
  }, [])

  const probe = useCallback(async () => {
    let d: any
    try {
      d = await api.browserStatus()
    } catch (e: any) {
      d = { running: false, reasons: ["Status check failed: " + e.message] }
    }
    setStatus(d)
    onState?.(d.running ? (d.browser || "running") : "not running")
  }, [onState])

  useEffect(() => {
    probe()
  }, [probe])

  // Live stream over the WebSocket while the browser is running.
  useEffect(() => {
    if (!status?.running) return
    const proto = location.protocol === "https:" ? "wss" : "ws"
    const qs = new URLSearchParams()
    if (api.host && api.host !== "local") qs.set("host", api.host)
    const ws = new WebSocket(`${proto}://${location.host}/api/browser/ws?${qs}`)
    ws.binaryType = "arraybuffer"
    wsRef.current = ws
    let lastObj: string | null = null
    let lastMsg = performance.now()
    ws.onmessage = (e) => {
      lastMsg = performance.now()
      if (typeof e.data === "string") {
        try {
          const m = JSON.parse(e.data)
          if (m.url && !urlFocused.current) setUrl(m.url)
        } catch {
          /* ignore */
        }
        return
      }
      const img = imgRef.current
      if (!img) return
      const obj = URL.createObjectURL(new Blob([e.data], { type: "image/jpeg" }))
      img.src = obj
      if (lastObj) URL.revokeObjectURL(lastObj)
      lastObj = obj
    }
    ws.onclose = () => {
      if (lastObj) URL.revokeObjectURL(lastObj)
    }
    // tab strip refresh
    const tabTimer = setInterval(() => {
      api.browserTabs().then((t: any) => Array.isArray(t) && setTabs(t)).catch(() => {})
    }, 2000)
    api.browserTabs().then((t: any) => Array.isArray(t) && setTabs(t)).catch(() => {})
    // watchdog: 6s of silence → re-probe
    const watch = setInterval(() => {
      if (performance.now() - lastMsg > 6000) probe()
    }, 2500)
    return () => {
      clearInterval(tabTimer)
      clearInterval(watch)
      if (lastObj) URL.revokeObjectURL(lastObj)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      wsRef.current = null
    }
  }, [status?.running, probe])

  const bvSend = (event: any) => {
    const evs = Array.isArray(event) ? event : [event]
    const ws = wsRef.current
    if (ws && ws.readyState === 1) {
      if (evs.length === 1 && evs[0].type === "move" && ws.bufferedAmount > 0) return
      try {
        ws.send(JSON.stringify(evs))
        return
      } catch {
        /* fall through */
      }
    }
    api.browserOp("input", { events: evs }).catch(() => {})
  }

  // Map a mouse event to the remote browser's pixel coords. The stream is drawn
  // with object-contain, so at aspect ratios that don't match the frame (docked,
  // odd window sizes) it's letterboxed inside the element — we must undo that
  // centering + fit scale, else clicks land off-target.
  const at = (e: React.MouseEvent) => {
    const img = imgRef.current!
    const r = img.getBoundingClientRect()
    const nw = img.naturalWidth
    const nh = img.naturalHeight
    if (!nw || !nh || !r.width || !r.height) {
      return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) }
    }
    const fit = Math.min(r.width / nw, r.height / nh) // object-contain scale
    const offX = (r.width - nw * fit) / 2 // letterbox padding
    const offY = (r.height - nh * fit) / 2
    const x = (e.clientX - r.left - offX) / fit
    const y = (e.clientY - r.top - offY) / fit
    return {
      x: Math.round(Math.max(0, Math.min(nw, x))),
      y: Math.round(Math.max(0, Math.min(nh, y))),
    }
  }
  const mods = (e: React.MouseEvent | React.KeyboardEvent) => ({
    ctrl: e.ctrlKey,
    meta: e.metaKey,
    alt: e.altKey,
    shift: e.shiftKey,
  })

  async function doAction(op: string, label: string) {
    setBusy(label)
    const r = await browserOp(op)
    setBusy(null)
    if (r?.error) setStatus((s: any) => ({ ...s, reasons: [r.error] }))
    else probe()
  }

  // Register a "playwright" MCP pointing at THIS browser into EVERY installed
  // agent's config (Claude/Codex/Pi), so any agent on the host can drive it.
  // (Pins the host's version-checked node dir — a bare `npx` can hit an ancient node.)
  async function saveMcp() {
    setMcpConfirm(false)
    const node = status?.node
    const dir = node ? node.slice(0, node.lastIndexOf("/")) : ""
    const config: Record<string, unknown> = {
      command: dir ? dir + "/npx" : "npx",
      args: ["@playwright/mcp@latest", "--cdp-endpoint", "http://127.0.0.1:9222"],
    }
    if (dir) config.env = { PATH: dir + ":/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" }
    try {
      const d = await (await api.mcpSaveBrowserAllAgents({ name: "playwright", config })).json()
      if (d.error) {
        setMcpNote("MCP save failed: " + d.error)
      } else {
        const saved = (d.saved || []) as string[]
        setMcpNote(
          saved.length
            ? `MCP saved for: ${saved.join(", ")} — new runs of those agents drive this browser`
            : "No installed agents to configure"
        )
        loadCapabilities()
      }
    } catch (e: any) {
      setMcpNote("MCP save failed: " + e.message)
    }
  }

  async function installXvfb() {
    setBusy("Installing virtual display (Xvfb) on the host")
    const r = await browserOp("install-xvfb")
    if (r?.error) {
      setBusy(null)
      setStatus((s: any) => ({ ...s, headless_note: r.error }))
      return
    }
    await browserOp("stop")
    await browserOp("start")
    setBusy(null)
    probe()
  }

  if (!status) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Checking browser…
      </div>
    )
  }

  if (!status.running) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm">
        {busy ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {busy}…
          </div>
        ) : (
          <>
            {(status.reasons || []).map((r: string, i: number) => (
              <div key={i} className="max-w-md text-center text-muted-foreground">
                {r}
              </div>
            ))}
            {status.action === "launch" && (
              <Button onClick={() => doAction("start", "Launching browser")}>Launch browser</Button>
            )}
            {status.action === "install" && (
              <Button onClick={() => doAction("install", "Downloading Chromium onto the host")}>
                Install Chromium (~300 MB, no sudo)
              </Button>
            )}
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[#1a1a1a]">
      {/* tab strip */}
      {tabs.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-border/40 bg-black/20 px-1 py-1">
          {tabs.map((t) => (
            <div
              key={t.id}
              onClick={() => browserOp("tab", { action: "select", id: t.id }).then((r) => r?.tabs && setTabs(r.tabs))}
              className={cn(
                "flex max-w-44 shrink-0 cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-white/70 hover:bg-white/10",
                t.active && "bg-white/15 text-white"
              )}
              title={t.url}
            >
              <span className="truncate">{t.title || t.url || "about:blank"}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  browserOp("tab", { action: "close", id: t.id }).then((r) => r?.tabs && setTabs(r.tabs))
                }}
                className="shrink-0 rounded hover:text-white"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          <button
            onClick={() => browserOp("tab", { action: "new" }).then((r) => r?.tabs && setTabs(r.tabs))}
            className="shrink-0 rounded p-1 text-white/70 hover:bg-white/10"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      )}

      {/* address bar */}
      <div className="flex items-center gap-1 border-b border-border/40 bg-black/20 px-2 py-1">
        <Button size="icon" variant="ghost" className="size-6 text-white/70" onClick={() => bvSend({ type: "back" })}>
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button size="icon" variant="ghost" className="size-6 text-white/70" onClick={() => bvSend({ type: "forward" })}>
          <ArrowRight className="size-3.5" />
        </Button>
        <Button size="icon" variant="ghost" className="size-6 text-white/70" onClick={() => bvSend({ type: "reload" })}>
          <RotateCw className="size-3.5" />
        </Button>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onFocus={() => (urlFocused.current = true)}
          onBlur={() => (urlFocused.current = false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              bvSend({ type: "navigate", url })
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          placeholder="Type a URL and press Enter — or let the agent drive"
          className="h-7 border-white/10 bg-black/30 text-xs text-white placeholder:text-white/40"
        />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-2 text-xs text-white/70"
          title="Save an MCP config so the Claude agent drives THIS browser"
          onClick={() => setMcpConfirm(true)}
        >
          Use in MCP
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-6 text-red-400"
          title="Stop browser"
          onClick={() => browserOp("stop").then(probe)}
        >
          <Power className="size-3.5" />
        </Button>
      </div>

      {/* headless warning + Xvfb upgrade */}
      {status.display_mode === "headless" && (
        <div className="flex flex-wrap items-center gap-2 bg-amber-500/15 px-3 py-1.5 text-xs text-amber-200">
          <span>⚠ {status.headless_note || "Running headless — sign-in on Google & similar is blocked."}</span>
          {status.can_install_xvfb && (
            <Button size="sm" variant="outline" className="ml-auto h-6 text-xs text-amber-950" onClick={installXvfb}>
              Install Xvfb &amp; relaunch headed
            </Button>
          )}
        </div>
      )}
      {mcpNote && <div className="bg-primary/10 px-3 py-1 text-xs text-primary">{mcpNote}</div>}
      {busy && (
        <div className="flex items-center gap-2 bg-black/30 px-3 py-1 text-xs text-white/70">
          <Loader2 className="size-3.5 animate-spin" /> {busy}…
        </div>
      )}

      {/* stream */}
      <div
        tabIndex={0}
        className="min-h-0 flex-1 overflow-hidden outline-none"
        onKeyDown={(e) => {
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            bvSend({ type: "text", text: e.key })
          } else {
            bvSend({ type: "key", key: e.key, ...mods(e) })
          }
          e.preventDefault()
        }}
      >
        <img
          ref={imgRef}
          alt="browser stream"
          draggable={false}
          className="block h-full w-full object-contain"
          onMouseDown={(e) => {
            e.preventDefault()
            downRef.current = true
            ;(e.currentTarget.parentElement as HTMLElement)?.focus()
            bvSend({ type: "down", ...at(e), button: e.button === 2 ? "right" : "left", ...mods(e) })
          }}
          onMouseUp={(e) => {
            if (!downRef.current) return
            downRef.current = false
            bvSend({ type: "up", ...at(e), button: e.button === 2 ? "right" : "left", ...mods(e) })
          }}
          onMouseMove={(e) => {
            const now = performance.now()
            if (now - lastMoveRef.current < 30) return
            lastMoveRef.current = now
            bvSend({ type: "move", ...at(e), buttons: downRef.current ? 1 : 0, ...mods(e) })
          }}
          onContextMenu={(e) => e.preventDefault()}
          onWheel={(e) => {
            bvSend({ type: "wheel", ...at(e), dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) })
          }}
        />
      </div>

      <Dialog open={mcpConfirm} onOpenChange={setMcpConfirm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Use this browser as an MCP server?</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Registers a <span className="font-mono text-foreground">playwright</span> MCP server
              pointing at this browser:
            </p>
            <p className="rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs text-foreground">
              --cdp-endpoint http://127.0.0.1:9222
            </p>
            <p>
              It's written into <strong className="text-foreground">every installed agent</strong>'s
              config (Claude, Codex, Pi) — in each one's native format — so any of them can drive the
              browser you see here.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMcpConfirm(false)}>
              Cancel
            </Button>
            <Button onClick={saveMcp}>Save MCP server</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
