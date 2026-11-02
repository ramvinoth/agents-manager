import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Bot, Loader2, ArrowDown, Upload } from "lucide-react"
import { useLive } from "./components/useLive"
import { DECISION_TABLES } from "./lib/live"
import { GitSection } from "@/components/GitSection"
import { Header } from "@/components/Header"
import { LeftPanel } from "@/components/LeftPanel"
import { Transcript } from "@/components/Transcript"
import { FileLinkProvider } from "@/components/FileLinks"
import { Composer } from "@/components/Composer"
import { PermissionPrompt } from "@/components/PermissionPrompt"
import { ToolsDialog } from "@/components/ToolsDialog"
import { ChatRedApprovals } from "@/components/RedApproval"
import { CanvasPane } from "@/components/CanvasPane"
import { canvasDragWidth, storedCanvasWidth } from "@/lib/canvas"
import { anchorFor, findKey, type FoundCall } from "@/lib/decisionAnchors"
import { api } from "@/lib/api"
import type { OpenDecision } from "@/lib/types"
import { AgentLoginDialog } from "@/components/AgentLoginDialog"
import { PairPhoneDialog } from "@/components/lazyDialogs"
import { SearchBar } from "@/components/SearchBar"
import { LoginPanel } from "@/components/LoginPanel"
import { AuthGate } from "@/components/AuthGate"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { useStore, useAgentLabel } from "@/store"
import { startUsageTracking } from "@/usageTracker"

// Lazy — pulls xterm + the CDP/PTY panel code only when a panel is opened.
const PanelDock = lazy(() =>
  import("@/components/PanelDock").then((m) => ({ default: m.PanelDock }))
)
const FileBrowser = lazy(() =>
  import("@/components/FileBrowser").then((m) => ({ default: m.FileBrowser }))
)

/** How long a "Show in chat" jump holds its place and rings the target. */
const JUMP_RING_MS = 4000
const CANVAS_W_KEY = "canvasWidth"

function App() {
  const init = useStore((s) => s.init)
  const turns = useStore((s) => s.turns)
  const sessionCwd = useStore((s) => s.meta?.cwd)
  const turnsLen = turns.length
  const loading = useStore((s) => s.loading)
  const error = useStore((s) => s.error)
  const currentSessionPath = useStore((s) => s.currentSessionPath)
  const chatRunning = useStore((s) => s.chatRunning)
  const panel = useStore((s) => s.panel)
  const fsOpen = useStore((s) => s.fsOpen)
  const dockSplit = useStore((s) => s.dockSplit)
  const setDockSplit = useStore((s) => s.setDockSplit)
  const panelFloating = useStore((s) => s.panelFloating)
  const floatRect = useStore((s) => s.floatRect)
  const setFloatRect = useStore((s) => s.setFloatRect)
  const searchOpen = useStore((s) => s.searchOpen)
  const openSearch = useStore((s) => s.openSearch)
  const searchMatches = useStore((s) => s.searchMatches)
  const searchIndex = useStore((s) => s.searchIndex)
  const currentMatch = searchMatches[searchIndex]
  const headOffset = useStore((s) => s.headOffset)
  const loadingOlder = useStore((s) => s.loadingOlder)
  const loadOlder = useStore((s) => s.loadOlder)
  const auth = useStore((s) => s.auth)
  const needsAuth = useStore((s) => s.needsAuth)
  const lhsOpen = useStore((s) => s.lhsOpen)
  const droppedFile = useStore((s) => s.droppedFile)
  const canvasOpen = useStore((s) => s.canvasOpen)
  const resetCanvases = useStore((s) => s.resetCanvases)
  const closeCanvas = useStore((s) => s.closeCanvas)
  // The owner's chosen canvas width (wide screens), kept across reloads; null = default layout.
  const [canvasW, setCanvasW] = useState(() => storedCanvasWidth(localStorage.getItem(CANVAS_W_KEY)))
  const [canvasResizing, setCanvasResizing] = useState(false)
  const loadNeeds = useStore((s) => s.loadNeeds)
  const agentLabel = useAgentLabel()

  const scrollRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const loadDroppedFile = useStore((s) => s.loadDroppedFile)
  const [dragging, setDragging] = useState(false)
  // /?pair=1 (the desktop app's "Pair a phone…") opens the QR dialog once signed in;
  // the param is dropped at once so a reload or a shared link does not reopen it.
  const [pairFromLink, setPairFromLink] = useState(() => {
    const q = new URLSearchParams(window.location.search)
    if (q.get("pair") !== "1") return false
    q.delete("pair")
    window.history.replaceState(null, "", window.location.pathname + (q.size ? `?${q}` : "") + window.location.hash)
    return true
  })
  const follow = useRef(true)
  const prependAnchor = useRef<number | null>(null)
  const [showJump, setShowJump] = useState(false)

  function jumpToLatest() {
    const el = scrollRef.current
    if (!el) return
    follow.current = true
    el.scrollTop = el.scrollHeight
    setShowJump(false)
  }

  useEffect(() => {
    init()
  }, [init])

  // Usage reporting starts once a human is signed in (the server only accepts
  // a human's events) and runs for the life of the page.
  const signedIn = useStore((s) => !!s.authUser)
  useEffect(() => {
    if (signedIn) startUsageTracking()
  }, [signedIn])

  useEffect(() => {
    follow.current = true
    setShowJump(false)
  }, [currentSessionPath])

  // The "Needs you" pane belongs to one session: a switch starts it fresh.
  useEffect(() => { resetCanvases() }, [currentSessionPath, resetCanvases])
  // What this chat is waiting on the owner for: checked on open, again the
  // moment a decision source changes (live events), and every 60s as the
  // fallback when the live socket is down.
  useEffect(() => {
    if (!currentSessionPath) return
    loadNeeds()
    const t = window.setInterval(() => document.visibilityState === "visible" && loadNeeds(), 60_000)
    return () => window.clearInterval(t)
  }, [currentSessionPath, loadNeeds])
  useLive(DECISION_TABLES, null, () => { if (currentSessionPath) loadNeeds() })

  useEffect(() => {
    const el = scrollRef.current
    if (el && follow.current) el.scrollTop = el.scrollHeight
    else if (el) setShowJump(true)
  }, [turnsLen])

  // Keep the working indicator in view when a run starts.
  useEffect(() => {
    const el = scrollRef.current
    if (el && follow.current && chatRunning) el.scrollTop = el.scrollHeight
  }, [chatRunning])

  // When older messages prepend, keep the viewport anchored (no jump).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && prependAnchor.current != null) {
      el.scrollTop = el.scrollHeight - prependAnchor.current
      prependAnchor.current = null
    }
  }, [turnsLen])

  // Ctrl/Cmd+F opens search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault()
        openSearch()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [openSearch])

  // Scroll to the current search match.
  useEffect(() => {
    if (!currentMatch) return
    follow.current = false
    document.getElementById("turn-" + currentMatch)?.scrollIntoView({ block: "center", behavior: "smooth" })
  }, [currentMatch])

  // "Show in chat" from the canvas pane: page older history in until the turn
  // that raised the decision is loaded, then scroll to it and ring it briefly.
  const [jumpHighlight, setJumpHighlight] = useState<string | undefined>()
  // While a jump lands and its ring shows, nothing may move it away: the scroll
  // events the jump itself fires must not re-arm follow-the-bottom (a target in
  // the last screenful reads as "at the bottom", and the next live message would
  // snap past it), and the top-of-history auto-load must not page in more.
  const jumpLock = useRef(0)
  // Paging in up to this many bytes of older history is quick; past it the
  // page would bloat, so the owner gets what that message said instead.
  const JUMP_BYTES = 8 << 20
  async function showInChat(d: OpenDecision): Promise<"shown" | "missing" | FoundCall> {
    let domId = anchorFor(d, useStore.getState().turns)
    if (!domId) {
      // The loaded tail misses it: ask the server where it is, however far up.
      const key = findKey(d)
      const { currentSessionPath: path, headOffset } = useStore.getState()
      if (!key || !path) return "missing"
      const hit = await api.sessionFind(path, key).then((r) => r.hit, () => null)
      if (!hit) return "missing"
      if (headOffset - hit.offset > JUMP_BYTES) return hit
    }
    for (let page = 0; !domId && page < 40 && useStore.getState().headOffset > 0; page++) {
      follow.current = false
      prependAnchor.current = scrollRef.current?.scrollHeight ?? null
      await useStore.getState().loadOlder()
      domId = anchorFor(d, useStore.getState().turns)
    }
    if (!domId) return "missing"
    follow.current = false
    prependAnchor.current = null
    jumpLock.current = Date.now() + JUMP_RING_MS
    // Instant and top-aligned, re-asserted once the last prepended page has
    // laid out: a smooth scroll is dropped while the live transcript re-renders.
    const land = () => document.getElementById("turn-" + domId)?.scrollIntoView({ block: "start" })
    requestAnimationFrame(land)
    window.setTimeout(land, 300)
    setJumpHighlight(domId)
    window.setTimeout(() => setJumpHighlight((h) => (h === domId ? undefined : h)), JUMP_RING_MS)
    return "shown"
  }

  function startDrag(e: React.MouseEvent) {
    e.preventDefault()
    const main = mainRef.current
    if (!main) return
    const onMove = (ev: MouseEvent) => {
      const r = main.getBoundingClientRect()
      setDockSplit((ev.clientY - r.top) / r.height)
    }
    const onUp = () => {
      document.removeEventListener("mousemove", onMove)
      document.removeEventListener("mouseup", onUp)
      document.body.classList.remove("select-none")
    }
    document.body.classList.add("select-none")
    document.addEventListener("mousemove", onMove)
    document.addEventListener("mouseup", onUp)
  }

  // Drag the divider left of the canvas: live width while dragging, saved on release;
  // dragged nearly shut it closes the pane (the saved width stays for next time).
  function canvasDividerDrag(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    setCanvasResizing(true)
    let last: number | "close" = canvasW ?? handle.parentElement!.getBoundingClientRect().width
    const onMove = (ev: PointerEvent) => {
      last = canvasDragWidth(window.innerWidth - ev.clientX, window.innerWidth)
      if (last !== "close") setCanvasW(last)
    }
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove)
      handle.removeEventListener("pointerup", onUp)
      handle.removeEventListener("pointercancel", onUp)
      setCanvasResizing(false)
      if (last === "close") {
        setCanvasW(storedCanvasWidth(localStorage.getItem(CANVAS_W_KEY)))
        closeCanvas()
      } else localStorage.setItem(CANVAS_W_KEY, String(last))
    }
    handle.addEventListener("pointermove", onMove)
    handle.addEventListener("pointerup", onUp)
    handle.addEventListener("pointercancel", onUp)
  }

  function resetCanvasWidth() {
    localStorage.removeItem(CANVAS_W_KEY)
    setCanvasW(null)
  }

  // Drag / resize the floating panel window.
  function floatGesture(e: React.MouseEvent, mode: "move" | "resize") {
    e.preventDefault()
    const start = { mx: e.clientX, my: e.clientY, ...floatRect }
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - start.mx
      const dy = ev.clientY - start.my
      if (mode === "move") {
        setFloatRect({
          ...start,
          x: Math.max(0, Math.min(window.innerWidth - 120, start.x + dx)),
          y: Math.max(48, Math.min(window.innerHeight - 40, start.y + dy)),
        })
      } else {
        setFloatRect({
          ...start,
          w: Math.max(320, Math.min(window.innerWidth - start.x - 8, start.w + dx)),
          h: Math.max(200, Math.min(window.innerHeight - start.y - 8, start.h + dy)),
        })
      }
    }
    const onUp = () => {
      document.removeEventListener("mousemove", onMove)
      document.removeEventListener("mouseup", onUp)
      document.body.classList.remove("select-none")
    }
    document.body.classList.add("select-none")
    document.addEventListener("mousemove", onMove)
    document.addEventListener("mouseup", onUp)
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <Header />
      <div className="flex min-h-0 flex-1">
        {!needsAuth && lhsOpen && (
          <aside className="hidden w-72 shrink-0 flex-col border-r border-border md:flex">
            <LeftPanel />
          </aside>
        )}
        <main
          ref={mainRef}
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer.types).includes("Files")) {
              e.preventDefault()
              setDragging(true)
            }
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDragging(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            const f = e.dataTransfer.files[0]
            if (f && /\.jsonl?$/i.test(f.name)) loadDroppedFile(f)
          }}
          className="relative flex min-w-0 flex-1 flex-col"
        >
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
              <div className="rounded-xl border-2 border-dashed border-primary px-10 py-8 text-center">
                <Upload className="mx-auto mb-2 size-8 text-primary" />
                <div className="text-sm font-medium">Drop a session .jsonl to view it</div>
              </div>
            </div>
          )}
          {searchOpen && <SearchBar />}
          {!needsAuth && <GitSection />}
          {/* PanelDock stays at ONE React position (keyed) so its live xterm/CDP
              sockets survive dock↔float toggles — only the wrapper's CSS changes. */}
          {panel && (
            <div
              key="panel-wrapper"
              className={
                panelFloating
                  ? "fixed z-40 flex flex-col overflow-hidden rounded-lg border border-border bg-background shadow-2xl"
                  : "relative min-h-0 shrink-0 grow-0"
              }
              style={
                panelFloating
                  ? { left: floatRect.x, top: floatRect.y, width: floatRect.w, height: floatRect.h }
                  : { flexBasis: `${dockSplit * 100}%` }
              }
            >
              <ErrorBoundary label="The panel crashed">
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" /> Loading panel…
                    </div>
                  }
                >
                  <PanelDock floating={panelFloating} onDragStart={(e) => floatGesture(e, "move")} />
                </Suspense>
              </ErrorBoundary>
              {panelFloating && (
                <div
                  onMouseDown={(e) => floatGesture(e, "resize")}
                  className="absolute bottom-0 right-0 z-10 size-4 cursor-nwse-resize"
                  title="Resize"
                />
              )}
            </div>
          )}
          {panel && !panelFloating && (
            <div
              key="dock-handle"
              onMouseDown={startDrag}
              className="h-1.5 shrink-0 cursor-row-resize bg-border transition-colors hover:bg-primary/50"
            />
          )}
          <div
            key="transcript"
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget
              const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 250
              const jumping = Date.now() < jumpLock.current
              if (!currentMatch && !jumping) follow.current = nearBottom
              setShowJump(!nearBottom || jumping)
              if (el.scrollTop < 80 && headOffset > 0 && !loadingOlder && !jumping) {
                prependAnchor.current = el.scrollHeight
                loadOlder()
              }
            }}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {needsAuth && !droppedFile ? (
              <AuthGate />
            ) : loading && !turns.length ? (
              <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading…
              </div>
            ) : error ? (
              <div className="flex h-64 items-center justify-center text-sm text-destructive">{error}</div>
            ) : (
              <ErrorBoundary key={currentSessionPath} label="Couldn't render this transcript">
                <FileLinkProvider cwd={sessionCwd}>
                  <Transcript turns={turns} highlightId={searchOpen ? currentMatch : jumpHighlight} />
                </FileLinkProvider>
              </ErrorBoundary>
            )}
            {chatRunning && !error && (
              <div className="mx-auto mb-6 flex max-w-3xl items-center gap-3 px-4">
                <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Bot className="size-3.5" />
                </div>
                <div className="flex items-center gap-1" role="status" aria-label={`${agentLabel} is working`}>
                  <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:-0.3s]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:-0.15s]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/70" />
                </div>
              </div>
            )}
            {showJump && (
              <div className="pointer-events-none sticky bottom-4 z-10 flex justify-center">
                <button
                  onClick={jumpToLatest}
                  className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur transition hover:bg-accent"
                >
                  <ArrowDown className="size-3.5" /> Latest
                </button>
              </div>
            )}
          </div>
          {needsAuth ? null : auth?.loggedIn === false ? (
            <LoginPanel />
          ) : (
            <>
              <ChatRedApprovals />
              <PermissionPrompt />
              <Composer />
            </>
          )}
        </main>
        {!needsAuth && canvasOpen && (
          // Wide: a column beside the chat, its width set by dragging the divider. Narrow: a full-screen sheet.
          // max-w keeps the chat usable when the window shrinks below a saved width.
          <aside
            style={{ "--canvas-w": canvasW ? `${canvasW}px` : "min(45vw,720px)" } as React.CSSProperties}
            className={`fixed inset-0 z-40 bg-background md:relative md:z-auto md:w-[var(--canvas-w)] md:max-w-[calc(100vw-360px)] md:shrink-0 md:border-l md:border-border ${canvasResizing ? "select-none [&_iframe]:pointer-events-none" : ""}`}
          >
            <div
              onPointerDown={canvasDividerDrag}
              onDoubleClick={resetCanvasWidth}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize canvas"
              title="Drag to resize · double-click to reset · drag to the edge to close"
              className={`absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize transition-colors hover:bg-primary/50 md:block ${canvasResizing ? "bg-primary/50" : ""}`}
            />
            <ErrorBoundary label="Canvas error">
              <CanvasPane onShowInChat={showInChat} />
            </ErrorBoundary>
          </aside>
        )}
      </div>
      {!needsAuth && (
        <ErrorBoundary label="Tools dialog error">
          <ToolsDialog />
        </ErrorBoundary>
      )}
      {fsOpen && (
        <Suspense fallback={null}>
          <ErrorBoundary label="File browser error">
            <FileBrowser />
          </ErrorBoundary>
        </Suspense>
      )}
      <AgentLoginDialog />
      {pairFromLink && !needsAuth && <PairPhoneDialog onClose={() => setPairFromLink(false)} />}
    </div>
  )
}

export default App
