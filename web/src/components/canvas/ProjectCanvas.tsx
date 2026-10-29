import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react"
import { Loader2 } from "lucide-react"
import { CaptureUpdateAction, Excalidraw, reconcileElements } from "@excalidraw/excalidraw"
import type { AppState, BinaryFileData, BinaryFiles, Collaborator, ExcalidrawImperativeAPI, SocketId } from "@excalidraw/excalidraw/types"
import "@excalidraw/excalidraw/index.css"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { backoffMs } from "@/lib/live"
import { userError } from "@/lib/errors"
import { PROTOCOL, Sync, checksum, collaborator, missingFiles, replaceById, type CanvasSnapshot, type El, type PresenceMsg, type RejectItem } from "@/lib/canvasSync"
import { parseCanvasRef, type CanvasRef } from "@/lib/canvasRef"
import { DocExpanded, DocTile, isDocLink, type DocMeta } from "./DocTile"

// Fonts are copied into dist by vite.config.ts (excalidrawAssets); without this
// Excalidraw fetches them from a public CDN, which a self-hosted box may not reach.
;(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/"

const SEND_MS = 50         // coalesce a stroke's onChange storm into one batch
const PRESENCE_MS = 33

export type Status = "connecting" | "live" | "offline" | "reload"

/**
 * ProjectCanvas — a project's shared canvas (Excalidraw), edited live by every
 * person who has it open. The server is the truth (viewer/canvas_room.py): a
 * snapshot over HTTP, then element diffs over one socket; lib/canvasSync holds
 * the protocol logic. Images upload once, before their element is sent.
 * Hosts: CanvasDialog (web) and CanvasEmbed (the phone's WebView).
 *
 * `load` fetches the first snapshot (the host knows how to name the board);
 * later resyncs go by canvas id. `settledRef` lets the host ask, before it
 * closes, whether every edit has reached the server. `onOpenRef` opens a
 * shape's harman:// link (a card, note, inbox, Sift doc or code path) in the
 * host's own UI; other links open as Excalidraw normally does.
 */
export function ProjectCanvas({ load, onStatus, settledRef, onOpenRef }: {
  load: () => Promise<CanvasSnapshot>
  onStatus?: (status: Status, editable: boolean) => void
  settledRef?: MutableRefObject<(() => boolean) | null>
  onOpenRef?: (ref: CanvasRef) => void
}) {
  const [board, setBoard] = useState<CanvasSnapshot | null>(null)
  const [err, setErr] = useState("")
  const [status, setStatus] = useState<Status>("connecting")
  // A line above the canvas; `undo` names the agent whose latest patch it takes back.
  const [notice, setNotice] = useState<{ text: string; undo?: string } | null>(null)
  const [api_, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  // A doc tile opened full size over the canvas.
  const [expanded, setExpanded] = useState<DocMeta | null>(null)
  const dark = document.documentElement.classList.contains("dark")

  // The host's loader may be a fresh closure each render; only mount and Try again fetch.
  const loadRef = useRef(load)
  loadRef.current = load
  const fetchBoard = useCallback(() => {
    setErr("")
    loadRef.current().then(setBoard).catch((e) => setErr(userError(e, "this project's canvas")))
  }, [])
  useEffect(fetchBoard, [fetchBoard])

  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus
  const onOpenRefRef = useRef(onOpenRef)
  onOpenRefRef.current = onOpenRef
  useEffect(() => { if (board) onStatusRef.current?.(status, board.editable) }, [status, board])

  // The person's net under an agent's edit: the server takes back that agent's
  // latest patch, skipping anything someone changed since.
  const undoAgent = (canvas: number, actor: string) =>
    api.canvasRevert(canvas, actor)
      .then((r) => setNotice({ text: r.reverted ? `Undid the agent's last change (${r.reverted} element${r.reverted === 1 ? "" : "s"}).` : "Nothing left to undo — it was already undone or changed since." }))
      .catch((e) => setNotice({ text: `Could not undo: ${userError(e, "the agent's change")}.` }))

  // The live half: one socket per open dialog, reconnecting with backoff.
  const sync = useRef<Sync | null>(null)
  const ws = useRef<WebSocket | null>(null)
  const onChangeRef = useRef<((els: unknown, s: AppState, files: BinaryFiles) => void) | null>(null)
  useEffect(() => {
    if (!board || !api_) return
    const ex = api_
    const cid = board.canvas
    const uploaded = new Set<string>()        // file ids the server holds
    const uploading = new Set<string>()
    const fetching = new Set<string>()
    const s = new Sync((f) => uploaded.has(f))
    sync.current = s
    for (const e of board.elements) if (e.type === "image" && e.fileId) uploaded.add(e.fileId)
    s.reset(board.elements)
    const peers = new Map<SocketId, Collaborator>()
    let closed = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let sendTimer: ReturnType<typeof setTimeout> | undefined

    const scene = () => ex.getSceneElementsIncludingDeleted() as unknown as El[]
    const send = (m: unknown) => {
      if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m))
    }
    const apply = (els: El[]) =>
      ex.updateScene({ elements: els as never, captureUpdate: CaptureUpdateAction.NEVER })
    const merge = (remote: El[]) =>
      apply(reconcileElements(scene() as never, remote as never, ex.getAppState()) as unknown as El[])

    const flush = () => {
      if (ws.current?.readyState !== WebSocket.OPEN || !board.editable) return
      for (const batch of s.outgoing(scene())) send({ t: "elements", elements: batch })
    }
    const upload = (files: BinaryFiles) => {
      if (!board.editable) return
      for (const f of Object.values(files)) {
        if (uploaded.has(f.id) || uploading.has(f.id)) continue
        uploading.add(f.id)
        fetch(f.dataURL)
          .then((r) => r.blob())
          .then((blob) => api.canvasFileUpload(cid, f.id, f.mimeType, blob))
          .then(() => {
            uploaded.add(f.id)
            flush()
          })
          .catch((e) => setNotice({ text: `An image could not be shared: ${userError(e, "the image")}. Only PNG, JPEG, GIF, WebP or SVG up to 4 MB.` }))
          .finally(() => uploading.delete(f.id))
      }
    }
    const fetchMissing = () => {
      const have = ex.getFiles()
      for (const id of missingFiles(scene(), (f) => !!have[f] || fetching.has(f))) {
        fetching.add(id)
        fetch(api.canvasFileUrl(cid, id))
          .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((blob) => new Promise<BinaryFileData>((ok, bad) => {
            const rd = new FileReader()
            rd.onload = () => ok({ id, mimeType: blob.type, dataURL: rd.result, created: Date.now() } as BinaryFileData)
            rd.onerror = () => bad(rd.error)
            rd.readAsDataURL(blob)
          }))
          .then((file) => {
            uploaded.add(id)
            ex.addFiles([file])
          })
          .catch(() => fetching.delete(id))      // a later scene change retries it
      }
    }
    const resnap = () =>
      api.canvasBoard({ id: cid }).then((b) => {
        if (closed) return
        merge(b.elements)
        s.reset(b.elements)
        for (const e of b.elements) if (e.type === "image" && e.fileId) uploaded.add(e.fileId)
        fetchMissing()
        flush()                                 // anything the server lacks goes now
      }, () => ws.current?.close())

    const connect = () => {
      if (closed) return
      setStatus("connecting")
      const proto = location.protocol === "https:" ? "wss" : "ws"
      const sock = new WebSocket(`${proto}://${location.host}/api/canvas/ws?canvas=${cid}`)
      ws.current = sock
      sock.onopen = () => sock.send(JSON.stringify({ t: "hello", protocol: PROTOCOL }))
      sock.onmessage = (ev) => {
        let m: { t?: string; [k: string]: unknown }
        try { m = JSON.parse(ev.data) } catch { return }
        switch (m.t) {
          case "hello":
            attempt = 0
            setStatus("live")
            resnap()
            break
          case "ack":
            s.acked()
            break
          case "elements": {
            const els = (m.elements as El[]) || []
            s.received(els)
            merge(els)
            fetchMissing()
            if (typeof m.from === "string" && m.from.startsWith("session:") && board.editable)
              setNotice({ text: "An agent changed the canvas.", undo: m.from })
            break
          }
          case "reject": {
            const local = new Map(scene().map((e) => [e.id, e]))
            const adopt = s.rejected((m.items as RejectItem[]) || [], local)
            if (adopt.length) apply(replaceById(scene(), adopt))
            if ((m.items as RejectItem[]).some(([, why]) => why === "read-only")) setNotice({ text: "This canvas is read-only for you." })
            flush()
            break
          }
          case "checksum":
            if (s.settled(scene()) && checksum(scene()) !== m.checksum) resnap()
            break
          case "resync":
            resnap()
            break
          case "reload":
            closed = true
            setStatus("reload")
            sock.close()
            break
          case "presence": {
            const p = m as unknown as PresenceMsg
            peers.set(p.peer as SocketId, collaborator(p) as Collaborator)
            ex.updateScene({ collaborators: new Map(peers) })
            break
          }
          case "leave":
            if (peers.delete(m.peer as SocketId)) ex.updateScene({ collaborators: new Map(peers) })
            break
        }
      }
      sock.onclose = () => {
        if (ws.current === sock) ws.current = null
        peers.clear()
        ex.updateScene({ collaborators: new Map() })
        if (closed) return
        setStatus("offline")
        timer = setTimeout(connect, backoffMs(attempt++))
      }
    }
    connect()

    onChangeRef.current = (_els, _state, files) => {
      upload(files)
      fetchMissing()
      clearTimeout(sendTimer)
      sendTimer = setTimeout(flush, SEND_MS)
    }
    return () => {
      closed = true
      clearTimeout(timer)
      clearTimeout(sendTimer)
      onChangeRef.current = null
      ws.current?.close()
      ws.current = null
      sync.current = null
    }
  }, [board, api_])

  // First view fits the whole board: centring alone leaves a phone-width
  // screen showing the middle of wide content, tiles clipped at both edges.
  // Never zooms past 100%, so a near-empty board does not open giant.
  const fitted = useRef<number | null>(null)
  useEffect(() => {
    if (!board || !api_ || fitted.current === board.canvas) return
    fitted.current = board.canvas
    api_.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9, maxZoom: 1 })
  }, [board, api_])

  const lastPresence = useRef(0)
  const onPointer = useCallback((p: { pointer: { x: number; y: number; tool: "pointer" | "laser" }; button: "down" | "up" }) => {
    const now = Date.now()
    if (now - lastPresence.current < PRESENCE_MS || ws.current?.readyState !== WebSocket.OPEN || !api_) return
    lastPresence.current = now
    ws.current.send(JSON.stringify({
      t: "presence", pointer: p.pointer, button: p.button, selected: api_.getAppState().selectedElementIds,
    }))
  }, [api_])

  useEffect(() => {
    if (!settledRef) return
    settledRef.current = () => {
      const s = sync.current
      return !s || !api_ || s.settled(api_.getSceneElementsIncludingDeleted() as unknown as El[])
    }
    return () => { settledRef.current = null }
  }, [settledRef, api_])

  return (
    <div className="flex size-full min-h-0 flex-col gap-2">
      {status === "reload" && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          Harman was updated. <button className="underline" onClick={() => location.reload()}>Reload the page</button> to keep drawing.
        </div>
      )}
      {notice && (
        <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
          <span>{notice.text}</span>
          <span className="flex gap-3">
            {notice.undo && board && (
              <button className="underline" onClick={() => undoAgent(board.canvas, notice.undo!)}>Undo</button>
            )}
            <button className="text-muted-foreground hover:text-foreground" onClick={() => setNotice(null)}>Dismiss</button>
          </span>
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border">
        {err ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm">
            <p>{err}</p>
            <Button variant="outline" size="sm" onClick={fetchBoard}>Try again</Button>
          </div>
        ) : !board ? (
          <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin" /></div>
        ) : (
          <Excalidraw
            excalidrawAPI={setApi}
            initialData={{ elements: board.elements as never }}
            isCollaborating
            viewModeEnabled={!board.editable}
            theme={dark ? "dark" : "light"}
            onChange={(els, st, files) => onChangeRef.current?.(els, st, files)}
            onPointerUpdate={onPointer}
            validateEmbeddable={isDocLink}
            onLinkOpen={(el, event) => {
              const ref = parseCanvasRef(el.link)
              if (!ref || !onOpenRefRef.current) return
              event.preventDefault()
              onOpenRefRef.current(ref)
            }}
            renderEmbeddable={(el) => {
              const doc = (el.customData as { doc?: DocMeta } | undefined)?.doc
              return doc ? <DocTile canvas={board.canvas} doc={doc} onExpand={() => setExpanded(doc)} /> : null
            }}
          />
        )}
        {expanded && board && <DocExpanded canvas={board.canvas} doc={expanded} onClose={() => setExpanded(null)} />}
      </div>
    </div>
  )
}

export function StatusDot({ status, editable }: { status: Status; editable: boolean }) {
  const label = status === "live" ? (editable ? "Live" : "Live · view only") : status === "connecting" ? "Connecting…" : status === "offline" ? "Offline · retrying" : "Update available"
  const dot = status === "live" ? "bg-emerald-500" : status === "connecting" ? "bg-amber-500" : "bg-red-500"
  return (
    <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
      <span className={`size-2 rounded-full ${dot}`} /> {label}
    </span>
  )
}
