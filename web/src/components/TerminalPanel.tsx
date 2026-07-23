import { useEffect, useRef } from "react"
import { Terminal as XTerm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import { api } from "@/lib/api"
import { useStore } from "@/store"

export function TerminalPanel({ onState }: { onState?: (s: string) => void }) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const termInit = useStore((s) => s.termInit)

  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 5000,
      fontFamily: "var(--font-mono, ui-monospace, Menlo, Consolas, monospace)",
      theme: {
        background: "#0d1117",
        foreground: "#c9d1d9",
        cursor: "#58a6ff",
        selectionBackground: "rgba(88,166,255,0.3)",
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(body)
    try {
      fit.fit()
    } catch {
      /* not sized yet */
    }

    const proto = location.protocol === "https:" ? "wss" : "ws"
    const params = new URLSearchParams({ cols: String(term.cols || 80), rows: String(term.rows || 24) })
    if (api.host && api.host !== "local") params.set("host", api.host)
    // A dedicated interactive session (e.g. `copilot --resume=<id>`): distinct
    // persistent key + one-time launch command. The backend only runs `init` when
    // the session is first created, so reattaching after a refresh never re-runs it.
    if (termInit) {
      params.set("key", termInit.key)
      params.set("init", termInit.cmd)
    }
    const ws = new WebSocket(`${proto}://${location.host}/api/terminal/ws?${params}`)
    ws.binaryType = "arraybuffer"

    const sendResize = () => {
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: "r", cols: term.cols, rows: term.rows }))
    }

    ws.onopen = () => {
      onState?.("connected")
      term.focus()
      setTimeout(sendResize, 40)
    }
    ws.onmessage = (e) => term.write(new Uint8Array(e.data as ArrayBuffer))
    ws.onclose = () => onState?.("disconnected")
    ws.onerror = () => onState?.("connection error")
    term.onData((d) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: "i", d }))
    })

    const onWin = () => sendResize()
    window.addEventListener("resize", onWin)
    const ro = new ResizeObserver(() => sendResize())
    ro.observe(body)

    return () => {
      window.removeEventListener("resize", onWin)
      ro.disconnect()
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      try {
        term.dispose()
      } catch {
        /* ignore */
      }
    }
    // termInit is read at mount; PanelDock remounts this panel (via its key) when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onState])

  return <div ref={bodyRef} className="h-full w-full bg-[#0d1117] p-1" />
}
