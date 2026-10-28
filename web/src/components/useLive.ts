import { useEffect, useRef } from "react"
import { backoffMs, matches, parse, type LiveEvent } from "../lib/live"

/** ONE WebSocket to /api/live/ws shared by every live surface: opened when
 *  the first listener mounts, closed when the last unmounts, reconnected with
 *  backoff. A reconnect is delivered as a resync — events sent while we were
 *  away are gone, so every surface refetches. */
type Listener = (ev: LiveEvent) => void
const listeners = new Set<Listener>()
let ws: WebSocket | null = null
let attempt = 0
let retry: ReturnType<typeof setTimeout> | null = null

function connect() {
  if (ws || !listeners.size) return
  const proto = location.protocol === "https:" ? "wss" : "ws"
  const sock = new WebSocket(`${proto}://${location.host}/api/live/ws`)
  ws = sock
  sock.onopen = () => {
    if (attempt > 0) listeners.forEach((l) => l({ t: "resync" }))
    attempt = 0
  }
  sock.onmessage = (m) => {
    const ev = parse(String(m.data))
    if (ev) listeners.forEach((l) => l(ev))
  }
  sock.onclose = () => {
    if (ws === sock) ws = null
    if (!listeners.size) return
    retry = setTimeout(() => { retry = null; connect() }, backoffMs(attempt++))
  }
}

function subscribe(l: Listener): () => void {
  listeners.add(l)
  connect()
  return () => {
    listeners.delete(l)
    if (listeners.size) return
    if (retry) { clearTimeout(retry); retry = null }
    ws?.close()
    ws = null
    attempt = 0
  }
}

/** Call `onChange` (debounced ~150ms, so a bulk reorder is one refetch) when
 *  a row in `tables` changes for `projectId` (null = any project), and on
 *  every resync. The surface keeps a slow poll as its fallback. */
export function useLive(tables: readonly string[], projectId: number | null, onChange: () => void) {
  const cb = useRef(onChange)
  cb.current = onChange
  const key = tables.join(",")
  useEffect(() => {
    const list = key.split(",")
    let t: ReturnType<typeof setTimeout> | null = null
    const off = subscribe((ev) => {
      if (!matches(ev, list, projectId)) return
      if (t) clearTimeout(t)
      t = setTimeout(() => { t = null; cb.current() }, 150)
    })
    return () => { off(); if (t) clearTimeout(t) }
  }, [key, projectId])
}
