/** One shared, self-healing WebSocket for a server push channel: opened when
 *  the first listener subscribes, closed when the last leaves, reopened with
 *  backoff after a drop, and declared dead when the server goes silent for
 *  `staleMs` (its keepalive pings stopped). Both of the web's push channels
 *  run on it — /api/live/ws (board rows, components/useLive.ts) and
 *  /api/events/ws (session runs and transcripts, store/runtime.ts).
 *
 *  The phone's twin is mobile-app/src/lib/liveEvents.ts (LiveStream): the
 *  apps share no build, so each keeps its own copy of this small loop.
 *
 *  Pure: the socket and timers are injected, node-tested. */

/** The slice of a WebSocket the feed drives (handlers take `any` so the DOM
 *  WebSocket, whose handlers take typed events, fits). */
export interface FeedSocket {
  onopen: ((ev?: any) => void) | null
  onmessage: ((m: any) => void) | null
  onclose: ((ev?: any) => void) | null
  onerror: ((ev?: any) => void) | null
  send(data: string): void
  close(): void
}

export interface FeedTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realTimers: FeedTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export interface FeedListener {
  /** A text frame arrived. */
  onMessage?: (raw: string) => void
  /** The socket opened; `reconnected` when an earlier socket of this feed
   *  dropped, so anything sent meanwhile was missed. */
  onOpen?: (reconnected: boolean) => void
  /** The socket dropped (closed, errored or went stale). */
  onClose?: () => void
}

/** Reconnect delay after `attempt` consecutive failures: 1s doubling to 30s. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt))
}

export class SocketFeed {
  private listeners = new Set<FeedListener>()
  private sock: FeedSocket | null = null
  private isOpen = false
  private attempt = 0
  private retry: unknown = null
  private stale: unknown = null
  private readonly openSocket: () => FeedSocket
  private readonly staleMs: number
  private readonly timers: FeedTimers

  /** `staleMs` 0 = never declare a quiet socket dead. */
  constructor(open: () => FeedSocket, staleMs = 0, timers: FeedTimers = realTimers) {
    this.openSocket = open
    this.staleMs = staleMs
    this.timers = timers
  }

  get open() {
    return this.isOpen
  }

  subscribe(l: FeedListener): () => void {
    this.listeners.add(l)
    if (!this.sock && this.retry == null) this.connect()
    let gone = false
    return () => {
      if (gone) return
      gone = true
      this.listeners.delete(l)
      if (!this.listeners.size) this.shutdown()
    }
  }

  /** Send a text frame; false when no socket is open (the caller re-sends on
   *  the next onOpen). */
  send(text: string): boolean {
    if (!this.sock || !this.isOpen) return false
    try {
      this.sock.send(text)
      return true
    } catch {
      return false
    }
  }

  private connect() {
    let sock: FeedSocket
    try {
      sock = this.openSocket()
    } catch {
      this.dropped(null)
      return
    }
    this.sock = sock
    this.armStale(sock)
    sock.onopen = () => {
      if (this.sock !== sock) return
      const reconnected = this.attempt > 0
      this.attempt = 0
      this.isOpen = true
      this.armStale(sock)
      for (const l of [...this.listeners]) l.onOpen?.(reconnected)
    }
    sock.onmessage = (m) => {
      if (this.sock !== sock) return
      this.armStale(sock)
      for (const l of [...this.listeners]) l.onMessage?.(String(m.data))
    }
    sock.onerror = () => {}
    sock.onclose = () => this.dropped(sock)
  }

  private dropped(sock: FeedSocket | null) {
    if (sock && this.sock !== sock) return // a replaced socket's late close
    const wasOpen = this.isOpen
    this.sock = null
    this.isOpen = false
    this.clearStale()
    if (wasOpen) for (const l of [...this.listeners]) l.onClose?.()
    if (!this.listeners.size || this.retry != null) return
    this.retry = this.timers.setTimeout(() => {
      this.retry = null
      if (this.listeners.size && !this.sock) this.connect()
    }, backoffMs(this.attempt++))
  }

  private armStale(sock: FeedSocket) {
    if (!this.staleMs) return
    this.clearStale()
    this.stale = this.timers.setTimeout(() => {
      this.stale = null
      if (this.sock !== sock) return
      try {
        sock.close()
      } catch {
        // already gone
      }
      this.dropped(sock)
    }, this.staleMs)
  }

  private clearStale() {
    if (this.stale != null) this.timers.clearTimeout(this.stale)
    this.stale = null
  }

  private shutdown() {
    const sock = this.sock
    this.sock = null
    this.isOpen = false
    this.clearStale()
    if (this.retry != null) this.timers.clearTimeout(this.retry)
    this.retry = null
    this.attempt = 0
    if (sock) {
      try {
        sock.close()
      } catch {
        // already gone
      }
    }
  }
}

/** ws(s)://<this page's host><path>. */
export function socketUrl(path: string, loc: { protocol: string; host: string } = location): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}${path}`
}
