import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Bot, Loader2, ArrowDown, Upload } from "lucide-react"
import { GitSection } from "@/components/GitSection"
import { Header } from "@/components/Header"
import { LeftPanel } from "@/components/LeftPanel"
import { Transcript } from "@/components/Transcript"
import { Composer } from "@/components/Composer"
import { RhsPanel } from "@/components/RhsPanel"
import { AgentLoginDialog } from "@/components/AgentLoginDialog"
import { SearchBar } from "@/components/SearchBar"
import { LoginPanel } from "@/components/LoginPanel"
import { AuthGate } from "@/components/AuthGate"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { useStore, useAgentLabel } from "@/store"

// Lazy — pulls xterm + the CDP/PTY panel code only when a panel is opened.
const PanelDock = lazy(() =>
  import("@/components/PanelDock").then((m) => ({ default: m.PanelDock }))
)
const FileBrowser = lazy(() =>
  import("@/components/FileBrowser").then((m) => ({ default: m.FileBrowser }))
)

function App() {
  const init = useStore((s) => s.init)
  const turns = useStore((s) => s.turns)
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
  const droppedFile = useStore((s) => s.droppedFile)
  const agentLabel = useAgentLabel()

  const scrollRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const loadDroppedFile = useStore((s) => s.loadDroppedFile)
  const [dragging, setDragging] = useState(false)
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

  useEffect(() => {
    follow.current = true
    setShowJump(false)
  }, [currentSessionPath])

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
        {!needsAuth && (
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
              if (!currentMatch) follow.current = nearBottom
              setShowJump(!nearBottom)
              if (el.scrollTop < 80 && headOffset > 0 && !loadingOlder) {
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
                <Transcript turns={turns} highlightId={searchOpen ? currentMatch : undefined} />
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
          {needsAuth ? null : auth?.loggedIn === false ? <LoginPanel /> : <Composer />}
        </main>
        {!needsAuth && (
          <aside className="hidden w-72 shrink-0 border-l border-border lg:block">
            <ErrorBoundary label="Skills panel error">
              <RhsPanel />
            </ErrorBoundary>
          </aside>
        )}
      </div>
      {fsOpen && (
        <Suspense fallback={null}>
          <ErrorBoundary label="File browser error">
            <FileBrowser />
          </ErrorBoundary>
        </Suspense>
      )}
      <AgentLoginDialog />
    </div>
  )
}

export default App
