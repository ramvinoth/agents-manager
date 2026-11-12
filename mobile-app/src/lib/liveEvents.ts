/**
 * The server's live-events stream (orchestrator/events.py, WebSocket /api/events/ws)
 * and the refresh loop screens build on it.
 *
 * The stream says WHEN something changed — a run started or ended, a
 * transcript grew, the chat list moved — so a screen fetches only that
 * resource instead of polling on a fixed beat. It is a hint channel, never the
 * data itself: every screen still owns its fetch, and polls on a backoff
 * whenever the stream is not live (an older server without the endpoint, a
 * relay hiccup, the socket dropping). One socket serves every screen.
 *
 * Pure: no react-native import (the socket and timers are injected), node-tested.
 */
import type { AppSocket } from "./deferredSocket.ts"

export type LiveEvent =
  | { type: "turn-start" | "turn-end" | "status-changed"; session: string }
  | { type: "transcript-changed"; session: string; size?: number; uuid?: string }
  | { type: "list-changed" | "resync" }
  /** The server's answer to a watch: whether it can see that transcript. */
  | { type: "watching"; session: string; ok: boolean }

const EVENT_TYPES = new Set(["turn-start", "turn-end", "status-changed", "transcript-changed", "list-changed", "resync", "watching"])
const SESSION_EVENTS = new Set(["turn-start", "turn-end", "status-changed", "transcript-changed", "watching"])

/** One transcript a screen has open. The server reports its growth even when
 *  no run of this server writes it (a CLI in a terminal, another host's chat). */
export interface WatchSpec {
  session: string
  host: string
  agent: string
  path: string
}

/** The server watches at most this many per client (orchestrator/events.py WATCH_MAX). */
export const WATCH_MAX = 4

/** A frame the screens act on, or null (hello/ping/garbage/unknown types from
 *  a newer server — ignored, never thrown). hello and ping only prove the
 *  stream is alive; LiveStream handles them itself. */
export function parseLiveEvent(data: unknown): LiveEvent | null {
  const obj = frame(data)
  if (!obj) return null
  const ev = obj as { type?: unknown; session?: unknown }
  if (typeof ev.type !== "string" || !EVENT_TYPES.has(ev.type)) return null
  if (SESSION_EVENTS.has(ev.type) && typeof ev.session !== "string") return null
  if (ev.type === "watching" && typeof (obj as { ok?: unknown }).ok !== "boolean") return null
  return obj as LiveEvent
}

function frame(data: unknown): object | null {
  if (typeof data !== "string") return null
  try {
    const obj: unknown = JSON.parse(data)
    return obj && typeof obj === "object" ? obj : null
  } catch {
    return null
  }
}

function frameType(data: unknown): string {
  const t = (frame(data) as { type?: unknown } | null)?.type
  return typeof t === "string" ? t : ""
}

/** Fallback poll steps while the stream is down: quick at first, then
 *  backing off while nothing changes; a change resets to the first step. */
export const LIST_FALLBACK_MS = [4000, 10000, 30000]
export const THREAD_FALLBACK_MS = [1500, 4000, 10000]
/** Reconnect delays after the socket drops. */
export const RECONNECT_MS = [1000, 3000, 10000, 30000]
/** No frame for this long (the server pings every 25s) → the socket is dead. */
export const STALE_MS = 60000
/** Keep the socket a moment after the last screen leaves, so a screen change
 *  (Chats → Thread) does not tear it down and reopen it. */
export const LINGER_MS = 5000

export class Backoff {
  private i = 0
  private readonly steps: number[]
  constructor(steps: number[]) {
    this.steps = steps
  }
  next(): number {
    const ms = this.steps[Math.min(this.i, this.steps.length - 1)]
    this.i++
    return ms
  }
  reset() {
    this.i = 0
  }
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export interface LiveListener {
  onEvent?: (ev: LiveEvent) => void
  /** The stream became live (true) or stopped being live (false). */
  onLive?: (live: boolean) => void
}

/** One shared socket, opened while anyone listens. "Live" means the server
 *  greeted us with hello — an old server without the endpoint never does, so
 *  its clients simply stay on their polls. */
export class LiveStream {
  private listeners = new Set<LiveListener>()
  private sock: AppSocket | null = null
  private isLive = false
  private reconnect = new Backoff(RECONNECT_MS)
  private retryTimer: unknown = null
  private staleTimer: unknown = null
  private lingerTimer: unknown = null
  private watches = new Map<object, WatchSpec>()
  /** Sessions the server answered `watching ok` for since the last watch frame. */
  private seen = new Set<string>()

  private readonly open: () => AppSocket
  private readonly timers: Timers

  constructor(open: () => AppSocket, timers: Timers = realTimers) {
    this.open = open
    this.timers = timers
  }

  get live() {
    return this.isLive
  }

  /** Whether the server said it sees this session's transcript. */
  watching(session: string) {
    return this.isLive && this.seen.has(session)
  }

  /** Ask the server to report one transcript's growth while the caller holds
   *  it. Returns release(). Re-sent on every reconnect. */
  watch(spec: WatchSpec): () => void {
    const key = {}
    this.watches.set(key, spec)
    this.sendWatch()
    return () => {
      if (this.watches.delete(key)) this.sendWatch()
    }
  }

  private sendWatch() {
    this.seen.clear()
    if (!this.isLive || !this.sock) return
    const specs = new Map<string, WatchSpec>()
    for (const w of this.watches.values()) if (specs.size < WATCH_MAX && !specs.has(w.session)) specs.set(w.session, w)
    try {
      this.sock.send(JSON.stringify({ type: "watch", sessions: [...specs.values()] }))
    } catch {
      // closing; the next hello re-sends
    }
  }

  subscribe(l: LiveListener): () => void {
    this.listeners.add(l)
    this.clear("lingerTimer")
    if (!this.sock && this.retryTimer == null) this.connect()
    let gone = false
    return () => {
      if (gone) return
      gone = true
      this.listeners.delete(l)
      if (this.listeners.size === 0 && this.lingerTimer == null) {
        this.lingerTimer = this.timers.setTimeout(() => {
          this.lingerTimer = null
          if (this.listeners.size === 0) this.shutdown()
        }, LINGER_MS)
      }
    }
  }

  private connect() {
    let sock: AppSocket
    try {
      sock = this.open()
    } catch {
      this.dropped(null)
      return
    }
    this.sock = sock
    this.armStale(sock)
    sock.onmessage = (ev) => {
      if (this.sock !== sock) return
      this.armStale(sock)
      if (frameType(ev.data) === "hello") {
        this.reconnect.reset()
        this.setLive(true)
        if (this.watches.size) this.sendWatch()
        return
      }
      const parsed = parseLiveEvent(ev.data)
      if (parsed?.type === "watching") {
        if (parsed.ok) this.seen.add(parsed.session)
        else this.seen.delete(parsed.session)
      }
      if (parsed) for (const l of [...this.listeners]) l.onEvent?.(parsed)
    }
    sock.onerror = () => {}
    sock.onclose = () => this.dropped(sock)
  }

  /** The socket closed, errored out, went silent or never opened. */
  private dropped(sock: AppSocket | null) {
    if (sock && this.sock !== sock) return // a stale socket's late close
    this.sock = null
    this.clear("staleTimer")
    this.setLive(false)
    if (this.listeners.size && this.retryTimer == null) {
      this.retryTimer = this.timers.setTimeout(() => {
        this.retryTimer = null
        if (this.listeners.size && !this.sock) this.connect()
      }, this.reconnect.next())
    }
  }

  private armStale(sock: AppSocket) {
    this.clear("staleTimer")
    this.staleTimer = this.timers.setTimeout(() => {
      this.staleTimer = null
      if (this.sock !== sock) return
      try {
        sock.close()
      } catch {
        // already gone
      }
      this.dropped(sock)
    }, STALE_MS)
  }

  private shutdown() {
    const sock = this.sock
    this.sock = null
    this.clear("staleTimer")
    this.clear("retryTimer")
    this.reconnect.reset()
    this.setLive(false)
    if (sock) {
      try {
        sock.close()
      } catch {
        // already gone
      }
    }
  }

  private setLive(live: boolean) {
    if (this.isLive === live) return
    this.isLive = live
    if (!live) this.seen.clear()
    for (const l of [...this.listeners]) l.onLive?.(live)
  }

  private clear(name: "retryTimer" | "staleTimer" | "lingerTimer") {
    if (this[name] != null) this.timers.clearTimeout(this[name])
    this[name] = null
  }
}

/** Run `fn` one at a time: a call made while one is in flight runs once more
 *  after it (several such calls collapse into that one). Resolves with the
 *  result of the run that covered the call. */
export function serialize<T>(fn: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null
  let queued: Promise<T> | null = null
  const run = (): Promise<T> => {
    running = fn().finally(() => {
      running = null
    })
    return running
  }
  return () => {
    if (!running) return run()
    if (!queued) {
      queued = running.catch(() => undefined).then(() => {
        queued = null
        return run()
      })
    }
    return queued
  }
}

export interface LiveRefreshOptions {
  /** null = no stream for this resource (e.g. another host): poll only. */
  stream: LiveStream | null
  /** Fetch the resource; resolve true when it changed. */
  refresh: () => Promise<boolean>
  /** Poll steps while the stream is not live. */
  fallbackMs: number[]
  /** While live, still refresh this often — a net for anything the stream
   *  cannot see (a durable question parked after the run ended…). */
  liveMs: number
  onEvent?: (ev: LiveEvent) => void
  /** The transcript this resource is. With `needsAck` the stream only counts
   *  as live for it once the server says it sees the file (another host's
   *  chat: no run of this server reports it otherwise). */
  watch?: WatchSpec & { needsAck?: boolean }
  timers?: Timers
}

/** Keep one resource fresh: on stream events (via onEvent) when the stream
 *  is live, on a backing-off poll when it is not. Catches up once each time
 *  the stream turns live (events may have been missed while it was down).
 *  Returns stop(). */
export function startLiveRefresh(o: LiveRefreshOptions): () => void {
  const timers = o.timers ?? realTimers
  const backoff = new Backoff(o.fallbackMs)
  const refresh = serialize(o.refresh)
  const stream = o.stream
  const isLive = () => !!stream && (o.watch?.needsAck ? stream.watching(o.watch.session) : stream.live)
  let live = isLive()
  let timer: unknown = null
  let stopped = false

  const schedule = () => {
    if (timer != null) timers.clearTimeout(timer)
    if (stopped) return
    timer = timers.setTimeout(tick, live ? o.liveMs : backoff.next())
  }
  const tick = () => {
    timer = null
    refresh()
      .then((changed) => {
        if (changed) backoff.reset()
      })
      .catch(() => {})
      .finally(schedule)
  }
  const turn = () => {
    const now = isLive()
    if (stopped || now === live) return
    live = now
    backoff.reset()
    if (timer != null) timers.clearTimeout(timer)
    timer = null
    if (now) tick()
    else schedule()
  }
  const unsubscribe = stream?.subscribe({
    onEvent: (ev) => {
      if (stopped) return
      if (ev.type === "watching") turn()
      o.onEvent?.(ev)
    },
    onLive: turn,
  })
  const unwatch = o.watch && stream ? stream.watch(o.watch) : undefined
  schedule()
  return () => {
    stopped = true
    if (timer != null) timers.clearTimeout(timer)
    timer = null
    unwatch?.()
    unsubscribe?.()
  }
}
