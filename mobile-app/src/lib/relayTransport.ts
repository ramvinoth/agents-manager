/**
 * The phone's transport over the Manager relay: one end-to-end encrypted
 * connection per server (relayChannel.ts) multiplexing HTTP requests and
 * WebSockets onto it, plus the choice between a server's direct address and
 * its relay route. The mirror of viewer/relay.py's Connection.
 *
 * Pure: the WebSocket constructor, the random source and the reachability
 * probe are injected, so all of it is node-tested against a fake server that
 * speaks the real protocol. src/api/transport.ts wires it to the app.
 *
 * Lifecycle: a RelayLink dials lazily on first use and keeps the connection
 * for later requests. When the relay or server drops it (close 1012 when the
 * server's side went away), every in-flight stream fails with a transport
 * error and the next request dials afresh with a new ephemeral key.
 */
import { concatBytes, toArrayBuffer, utf8Decode, utf8Encode } from "./bytes.ts"
import type { RelayRoute } from "./pairLink.ts"
import {
  CANCEL,
  CHUNK,
  ERROR,
  HTTP_BODY,
  HTTP_END,
  HTTP_REQ,
  RES_BODY,
  RES_END,
  RES_HEAD,
  RelayChannel,
  WS_BINARY,
  WS_CLOSE,
  WS_OPEN,
  WS_OPENED,
  WS_TEXT,
  pack,
  unpack,
} from "./relayChannel.ts"

/** The slice of a WebSocket the relay connection drives. */
export interface WireSocket {
  binaryType: string
  readyState: number
  send(data: string | ArrayBuffer): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
}

export type RelayDeps = {
  WebSocket: new (url: string) => WireSocket
  randomBytes: (n: number) => Uint8Array
  /** Hello resend period; the relay may hold our first one until the server
   *  attaches, and the server answers every hello it sees. */
  helloEveryMs?: number
  /** Give up on a handshake after this long. */
  handshakeMs?: number
}

export type RelayRequest = {
  method: string
  path: string
  headers: Record<string, string>
  body?: Uint8Array
}

export type RelayResponse = {
  status: number
  /** Lower-cased names. */
  headers: Record<string, string>
  body: Uint8Array
}

/** Matches the server's MAX_STREAMS: more than this in flight would be
 *  refused there, so extra streams wait here for a slot instead. */
export const MAX_STREAMS = 32

/** Message prefix for every relay transport failure, so errors.ts maps it to
 *  "Can't reach the server" exactly like a failed direct fetch. */
const FAILED = "Network request failed"

export class TooLargeError extends Error {}

type StreamHandler = { frame(kind: number, payload: Uint8Array): void; fail(err: Error): void }

export function relaySocketUrl(route: RelayRoute): string {
  const base = route.url.replace(/^https:/i, "wss:").replace(/\/+$/, "")
  return `${base}/ws?serverId=${encodeURIComponent(route.serverId)}&role=client`
}

/** One live relay connection: handshake done, streams multiplexed. */
class Wire {
  private readonly streams = new Map<number, StreamHandler>()
  private readonly waiting: Array<() => void> = []
  private nextId = 1
  private dead: Error | null = null

  private readonly ws: WireSocket
  private readonly channel: RelayChannel
  private readonly onDead: () => void

  constructor(ws: WireSocket, channel: RelayChannel, onDead: () => void) {
    this.ws = ws
    this.channel = channel
    this.onDead = onDead
  }

  static open(route: RelayRoute, deps: RelayDeps, onDead: () => void): Promise<Wire> {
    const ws = new deps.WebSocket(relaySocketUrl(route))
    ws.binaryType = "arraybuffer"
    const channel = new RelayChannel(route.publicKey, deps.randomBytes(32))
    const wire = new Wire(ws, channel, onDead)
    return new Promise((resolve, reject) => {
      let hello: ReturnType<typeof setInterval> | undefined
      const stop = () => {
        clearInterval(hello)
        clearTimeout(timer)
      }
      const timer = setTimeout(() => {
        stop()
        reject(new Error(`${FAILED} (relay handshake timed out)`))
        wire.die(new Error(`${FAILED} (relay handshake timed out)`))
      }, deps.handshakeMs ?? 15000)
      const sendHello = () => {
        try {
          ws.send(channel.hello())
        } catch {
          // closing; onclose settles it
        }
      }
      ws.onopen = () => {
        sendHello()
        hello = setInterval(sendHello, deps.helloEveryMs ?? 1000)
      }
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          if (!channel.ready && channel.acceptText(ev.data)) {
            stop()
            resolve(wire)
          }
          return
        }
        if (channel.ready && ev.data instanceof ArrayBuffer) wire.receive(new Uint8Array(ev.data))
      }
      ws.onerror = () => {}
      ws.onclose = (ev) => {
        stop()
        const err = new Error(`${FAILED} (relay closed${ev?.code ? ` ${ev.code}` : ""})`)
        reject(err)
        wire.die(err)
      }
    })
  }

  private receive(frame: Uint8Array) {
    let msg
    try {
      msg = unpack(this.channel.open(frame))
    } catch (e) {
      this.die(new Error(`${FAILED} (relay: ${(e as Error).message})`))
      return
    }
    this.streams.get(msg.stream)?.frame(msg.kind, msg.payload)
  }

  send(kind: number, stream: number, payload?: Uint8Array) {
    if (this.dead) throw this.dead
    this.ws.send(toArrayBuffer(this.channel.seal(pack(kind, stream, payload))))
  }

  /** Reserve a stream id once fewer than MAX_STREAMS are open. */
  async open(handler: StreamHandler): Promise<number> {
    while (this.streams.size >= MAX_STREAMS) {
      if (this.dead) throw this.dead
      await new Promise<void>((r) => this.waiting.push(r))
    }
    if (this.dead) throw this.dead
    const id = this.nextId++
    this.streams.set(id, handler)
    return id
  }

  finish(id: number) {
    if (this.streams.delete(id)) this.waiting.shift()?.()
  }

  die(err: Error) {
    if (this.dead) return
    this.dead = err
    const streams = [...this.streams.values()]
    this.streams.clear()
    for (const s of streams) s.fail(err)
    for (const w of this.waiting.splice(0)) w()
    try {
      this.ws.close()
    } catch {
      // already closed
    }
    this.onDead()
  }

  /** One HTTP exchange. `maxBytes` caps the response body (it is held in
   *  memory); a bigger one is cancelled and rejects with TooLargeError. */
  async fetch(req: RelayRequest, maxBytes = Infinity): Promise<RelayResponse> {
    let settle!: { resolve: (r: RelayResponse) => void; reject: (e: Error) => void }
    const done = new Promise<RelayResponse>((resolve, reject) => (settle = { resolve, reject }))
    let head: { status: number; headers: Record<string, string> } | null = null
    const chunks: Uint8Array[] = []
    let total = 0
    let id = 0
    const end = (err: Error | null, res?: RelayResponse) => {
      this.finish(id)
      if (err) settle.reject(err)
      else settle.resolve(res!)
    }
    const tooLarge = () => {
      try {
        this.send(CANCEL, id)
      } catch {
        // connection gone; nothing to cancel
      }
      end(new TooLargeError(`Too large to transfer through the Manager relay (over ${Math.round(maxBytes / 1048576)} MB)`))
    }
    id = await this.open({
      frame: (kind, payload) => {
        if (kind === RES_HEAD) {
          try {
            const h = JSON.parse(utf8Decode(payload))
            const headers: Record<string, string> = {}
            for (const [k, v] of Object.entries(h.headers || {})) headers[k.toLowerCase()] = String(v)
            head = { status: Number(h.status) || 0, headers }
          } catch {
            end(new Error(`${FAILED} (relay: malformed response)`))
            return
          }
          if (Number(head.headers["content-length"]) > maxBytes) tooLarge()
        } else if (kind === RES_BODY) {
          total += payload.length
          if (total > maxBytes) tooLarge()
          else chunks.push(payload)
        } else if (kind === RES_END) {
          if (!head) end(new Error(`${FAILED} (relay: response without head)`))
          else end(null, { ...head, body: concatBytes(chunks) })
        } else if (kind === ERROR) {
          end(new Error(`${FAILED} (relay: ${utf8Decode(payload)})`))
        }
      },
      fail: (err) => settle.reject(err),
    })
    try {
      // The relay carries no chunked framing, so the loopback server learns a
      // body's size only from Content-Length.
      const body = req.body
      const headers = { ...req.headers }
      if (body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-length")) {
        headers["Content-Length"] = String(body.length)
      }
      this.send(HTTP_REQ, id, utf8Encode(JSON.stringify({ method: req.method, path: req.path, headers })))
      if (body) for (let off = 0; off < body.length; off += CHUNK) this.send(HTTP_BODY, id, body.subarray(off, off + CHUNK))
      this.send(HTTP_END, id)
    } catch (e) {
      end(e as Error)
    }
    return done
  }

  async attach(socket: RelaySocket, path: string, headers: Record<string, string>) {
    const id = await this.open(socket.handler)
    socket.bind(this, id)
    if (socket.readyState !== RelaySocket.CONNECTING) return // closed while waiting
    this.send(WS_OPEN, id, utf8Encode(JSON.stringify({ path, headers })))
  }
}

/**
 * A WebSocket carried inside the relay connection. Shaped like the RN
 * WebSocket the app's consumers already drive: readyState, the on* handlers,
 * send(string | ArrayBuffer) and close(). Text arrives as a string, binary as
 * an ArrayBuffer (as with binaryType "arraybuffer").
 */
export class RelaySocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = RelaySocket.CONNECTING
  binaryType = "arraybuffer"
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: { message?: string }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null

  private wire: Wire | null = null
  private id = 0

  readonly handler: StreamHandler = {
    frame: (kind, payload) => {
      if (kind === WS_OPENED) {
        if (this.readyState !== RelaySocket.CONNECTING) return
        this.readyState = RelaySocket.OPEN
        this.onopen?.({})
      } else if (kind === WS_TEXT) {
        this.onmessage?.({ data: utf8Decode(payload) })
      } else if (kind === WS_BINARY) {
        this.onmessage?.({ data: toArrayBuffer(payload) })
      } else if (kind === WS_CLOSE) {
        const code = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 1005
        this.finish(code, "")
      } else if (kind === ERROR) {
        this.fail(new Error(utf8Decode(payload)))
      }
    },
    fail: (err) => this.fail(err),
  }

  bind(wire: Wire, id: number) {
    this.wire = wire
    this.id = id
    if (this.readyState === RelaySocket.CLOSED) wire.finish(id)
  }

  send(data: string | ArrayBuffer | Uint8Array) {
    if (this.readyState !== RelaySocket.OPEN || !this.wire) throw new Error("WebSocket is not open")
    if (typeof data === "string") this.wire.send(WS_TEXT, this.id, utf8Encode(data))
    else this.wire.send(WS_BINARY, this.id, data instanceof Uint8Array ? data : new Uint8Array(data))
  }

  close(code = 1000) {
    if (this.readyState >= RelaySocket.CLOSING) return
    if (this.wire) {
      try {
        this.wire.send(WS_CLOSE, this.id, new Uint8Array([code >> 8, code & 0xff]))
      } catch {
        // connection already gone
      }
    }
    this.finish(code, "")
  }

  fail(err: Error) {
    if (this.readyState === RelaySocket.CLOSED) return
    this.onerror?.({ message: err.message })
    this.finish(1006, err.message)
  }

  private finish(code: number, reason: string) {
    if (this.readyState === RelaySocket.CLOSED) return
    this.readyState = RelaySocket.CLOSED
    if (this.wire) this.wire.finish(this.id)
    this.onclose?.({ code, reason })
  }
}

/** A server's relay route, dialed lazily and redialed after a drop. */
export class RelayLink {
  private wire: Promise<Wire> | null = null
  private closed = false

  readonly route: RelayRoute
  private readonly deps: RelayDeps

  constructor(route: RelayRoute, deps: RelayDeps) {
    this.route = route
    this.deps = deps
  }

  private connect(): Promise<Wire> {
    if (this.closed) return Promise.reject(new Error(`${FAILED} (relay link closed)`))
    if (!this.wire) {
      const wire = Wire.open(this.route, this.deps, () => {
        if (this.wire === wire) this.wire = null
      })
      wire.catch(() => {
        if (this.wire === wire) this.wire = null
      })
      this.wire = wire
    }
    return this.wire
  }

  async fetch(req: RelayRequest, maxBytes?: number): Promise<RelayResponse> {
    return (await this.connect()).fetch(req, maxBytes)
  }

  openSocket(path: string, headers: Record<string, string>): RelaySocket {
    const socket = new RelaySocket()
    this.connect()
      .then((wire) => wire.attach(socket, path, headers))
      .catch((e) => socket.fail(e as Error))
    return socket
  }

  /** Drop the connection for good (server removed or switched away). */
  close() {
    this.closed = true
    this.wire?.then((w) => w.die(new Error(`${FAILED} (relay link closed)`)), () => {})
    this.wire = null
  }
}

/**
 * Which route to use for a server that has both a direct address and a relay
 * route (Paseo's selectBestConnection): direct when its /healthz answers,
 * else the relay. The verdict is cached for `ttlMs` so a phone that walks
 * back onto its home network returns to direct, and is dropped early when a
 * direct request fails at the transport level.
 */
export class RouteChooser {
  private verdict: { direct: boolean; at: number } | null = null
  private probing: Promise<boolean> | null = null

  private readonly probe: () => Promise<boolean>
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(probe: () => Promise<boolean>, now: () => number = Date.now, ttlMs = 60000) {
    this.probe = probe
    this.now = now
    this.ttlMs = ttlMs
  }

  async useDirect(): Promise<boolean> {
    if (this.verdict && this.now() - this.verdict.at < this.ttlMs) return this.verdict.direct
    if (!this.probing) {
      this.probing = this.probe()
        .catch(() => false)
        .then((direct) => {
          this.verdict = { direct, at: this.now() }
          this.probing = null
          return direct
        })
    }
    return this.probing
  }

  /** A direct request failed to reach the server: use the relay until the
   *  next probe. */
  directFailed() {
    this.verdict = { direct: false, at: this.now() }
  }
}
