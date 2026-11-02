import { useEffect, useRef } from "react"
import { matches, parse, type LiveEvent } from "../lib/live"
import { SocketFeed, socketUrl } from "../lib/socketFeed"

/** ONE WebSocket to /api/live/ws shared by every live surface (lib/socketFeed:
 *  opened by the first listener, closed with the last, reconnected with
 *  backoff). A reconnect is delivered as a resync — events sent while we were
 *  away are gone, so every surface refetches. */
type Listener = (ev: LiveEvent) => void
const feed = new SocketFeed(() => new WebSocket(socketUrl("/api/live/ws")))

function subscribe(l: Listener): () => void {
  return feed.subscribe({
    onOpen: (reconnected) => { if (reconnected) l({ t: "resync" }) },
    onMessage: (raw) => {
      const ev = parse(raw)
      if (ev) l(ev)
    },
  })
}

/** Call `onChange` (debounced ~150ms, so a bulk reorder is one refetch) when
 *  a row in `tables` changes for `projectId` (null = any project), and on
 *  every resync. Returns unsubscribe. For code outside React (store/). */
export function watchLive(tables: readonly string[], projectId: number | null, onChange: () => void): () => void {
  let t: ReturnType<typeof setTimeout> | null = null
  const off = subscribe((ev) => {
    if (!matches(ev, tables, projectId)) return
    if (t) clearTimeout(t)
    t = setTimeout(() => { t = null; onChange() }, 150)
  })
  return () => { off(); if (t) clearTimeout(t) }
}

/** watchLive as a hook. The surface keeps a slow poll as its fallback. */
export function useLive(tables: readonly string[], projectId: number | null, onChange: () => void) {
  const cb = useRef(onChange)
  cb.current = onChange
  const key = tables.join(",")
  useEffect(() => watchLive(key.split(","), projectId, () => cb.current()), [key, projectId])
}
