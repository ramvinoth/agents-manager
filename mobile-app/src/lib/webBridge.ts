/**
 * The bridge between a server web page shown in the app (the project canvas)
 * and the app's ServerTransport — so the page works over the Harman relay as
 * well as a direct address.
 *
 * The page is loaded from the custom origin harman://app. Every request it
 * makes (the HTML, scripts, fonts, /api/ calls) arrives at the native scheme
 * handler, which hands it here; `answer` sends it on through the transport
 * and the response goes back to the page as-is. The page's WebSockets to
 * ws://app/... are replaced by `wsShimScript`, which posts each socket's
 * open/send/close to the app; `SocketBridge` opens the real socket through
 * the transport and posts its events back. The page never knows which route
 * carried anything, and never holds a credential: the transport adds the
 * Bearer token to every request and socket.
 *
 * Pure: the transport and the native view are injected.
 */
import { fromBase64, toBase64 } from "./bytes.ts"
import type { AppSocket } from "./deferredSocket.ts"
import type { RawReply } from "./serverTransport.ts"

/** The origin the bridged page is loaded from. */
export const APP_SCHEME = "harman"
export const APP_HOST = "app"
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`

/** One request from the page, as the native scheme handler saw it. */
export interface BridgeRequest {
  method: string
  /** Path and query, starting with "/". */
  path: string
  headers: Record<string, string>
  body?: Uint8Array
}

export type Exchange = (method: string, path: string, headers: Record<string, string>, body?: Uint8Array) => Promise<RawReply>

/** The path + query of a URL on the page's own origin (harman://app, or
 *  ws(s)://app for its sockets); null for anything else. */
export function bridgePath(url: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^#]*)/i.exec(url)
  if (!m || m[2].toLowerCase() !== APP_HOST) return null
  const scheme = m[1].toLowerCase()
  if (scheme !== APP_SCHEME && scheme !== "ws" && scheme !== "wss") return null
  const rest = m[3] || "/"
  return rest.startsWith("/") ? rest : `/${rest}`
}

/** Request headers the page's browser adds that must not reach the server:
 *  its cookies (the transport authenticates), and Accept-Encoding — the
 *  server gzips when asked, and the bytes go back to the page as-is, so the
 *  body must arrive plain. */
const DROP_REQUEST = new Set(["cookie", "accept-encoding", "host", "origin", "connection", "content-length"])

export function requestHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { "accept-encoding": "identity" }
  for (const [name, value] of Object.entries(headers)) {
    const n = name.toLowerCase()
    if (!DROP_REQUEST.has(n)) out[n] = value
  }
  return out
}

/** Response headers that describe the wire, not the body handed to the page
 *  (RN's fetch has already decoded and de-chunked it), or that would set a
 *  cookie on an origin the server never sees. */
const DROP_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie", "keep-alive"])

export function responseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const n = name.toLowerCase()
    if (!DROP_RESPONSE.has(n)) out[n] = value
  }
  return out
}

/** Build output whose content never changes under the same URL: Vite's
 *  content-hashed /assets/ and Excalidraw's per-version font files. */
export function isImmutable(path: string): boolean {
  return /^\/(assets|excalidraw-assets)\//.test(path)
}

/** The page's immutable files, kept in memory so reopening the canvas over
 *  the relay doesn't fetch megabytes of scripts again. Bounded by bytes,
 *  least-recently-used out first; a file over a quarter of the budget is
 *  never kept (it would evict everything else). */
export class AssetCache {
  private readonly entries = new Map<string, RawReply>()
  private bytes = 0
  readonly maxBytes: number
  constructor(maxBytes: number) {
    this.maxBytes = maxBytes
  }

  get(key: string): RawReply | undefined {
    const hit = this.entries.get(key)
    if (hit) {
      this.entries.delete(key)
      this.entries.set(key, hit)
    }
    return hit
  }

  put(key: string, reply: RawReply) {
    const size = reply.body.length
    if (size > this.maxBytes / 4) return
    const old = this.entries.get(key)
    if (old) {
      this.bytes -= old.body.length
      this.entries.delete(key)
    }
    this.entries.set(key, reply)
    this.bytes += size
    for (const [k, v] of this.entries) {
      if (this.bytes <= this.maxBytes) break
      this.entries.delete(k)
      this.bytes -= v.body.length
    }
  }

  get size(): number {
    return this.bytes
  }
}

/** Answer one page request through the transport. `scope` names the server
 *  so two servers' files never mix in the cache. */
export async function answer(req: BridgeRequest, exchange: Exchange, cache: AssetCache, scope: string): Promise<RawReply> {
  const method = req.method.toUpperCase()
  const keep = method === "GET" && isImmutable(req.path)
  const key = `${scope} ${req.path}`
  const hit = keep ? cache.get(key) : undefined
  if (hit) return hit
  const res = await exchange(method, req.path, requestHeaders(req.headers), req.body)
  const out: RawReply = { status: res.status, headers: responseHeaders(res.headers), body: res.body }
  if (keep && res.status === 200) cache.put(key, out)
  return out
}

/** A message from the page's socket shim. */
export type PageSocketMessage =
  | { t: "ws-open"; id: number; url: string }
  | { t: "ws-send"; id: number; text?: string; b64?: string }
  | { t: "ws-close"; id: number; code?: number }

/** A socket event for the page (window.__harmanWs). */
export type SocketEvent =
  | { id: number; t: "open" }
  | { id: number; t: "text"; data: string }
  | { id: number; t: "binary"; data: string }
  | { id: number; t: "error" }
  | { id: number; t: "close"; code: number; reason: string }

/** Parse a page message; null for anything that isn't a well-formed socket
 *  message (the page is ours, but a malformed message must not throw). */
export function parsePageMessage(raw: string): PageSocketMessage | null {
  let m: unknown
  try {
    m = JSON.parse(raw)
  } catch {
    return null
  }
  if (!m || typeof m !== "object") return null
  const o = m as Record<string, unknown>
  if (typeof o.id !== "number") return null
  if (o.t === "ws-open" && typeof o.url === "string") return { t: "ws-open", id: o.id, url: o.url }
  if (o.t === "ws-send" && (typeof o.text === "string" || typeof o.b64 === "string")) {
    return typeof o.text === "string" ? { t: "ws-send", id: o.id, text: o.text } : { t: "ws-send", id: o.id, b64: o.b64 as string }
  }
  if (o.t === "ws-close") return { t: "ws-close", id: o.id, code: typeof o.code === "number" ? o.code : undefined }
  return null
}

/** A tile the page asked to open — a harman://<kind>/<id> link on the canvas.
 *  Card and note ids are integers; inbox, code and sift ids are strings. */
export type OpenRef =
  | { kind: "card" | "note"; id: number }
  | { kind: "inbox" | "code" | "sift"; id: string }

export function parseOpenRef(raw: string): OpenRef | null {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(raw)
  } catch {
    return null
  }
  if (!o || typeof o !== "object" || o.t !== "open" || typeof o.id !== "string" || !o.id) return null
  if (o.kind === "card" || o.kind === "note") {
    return /^[1-9]\d*$/.test(o.id) ? { kind: o.kind, id: Number(o.id) } : null
  }
  if (o.kind === "inbox" || o.kind === "code" || o.kind === "sift") return { kind: o.kind, id: o.id }
  return null
}

/** The page's sockets, each opened through the transport. */
export class SocketBridge {
  private readonly sockets = new Map<number, AppSocket>()
  private readonly open: (path: string) => AppSocket
  private readonly deliver: (ev: SocketEvent) => void
  constructor(open: (path: string) => AppSocket, deliver: (ev: SocketEvent) => void) {
    this.open = open
    this.deliver = deliver
  }

  handle(msg: PageSocketMessage) {
    if (msg.t === "ws-open") return this.openOne(msg.id, msg.url)
    const sock = this.sockets.get(msg.id)
    if (!sock) return
    if (msg.t === "ws-send") {
      try {
        sock.send(msg.text !== undefined ? msg.text : fromBase64(msg.b64!))
      } catch {
        this.deliver({ id: msg.id, t: "error" })
      }
    } else {
      this.sockets.delete(msg.id)
      sock.close(msg.code ?? 1000)
      this.deliver({ id: msg.id, t: "close", code: msg.code ?? 1000, reason: "" })
    }
  }

  private openOne(id: number, url: string) {
    const path = bridgePath(url)
    if (!path || !path.startsWith("/api/")) {
      this.deliver({ id, t: "error" })
      this.deliver({ id, t: "close", code: 1006, reason: "Not a Harman socket" })
      return
    }
    let sock: AppSocket
    try {
      sock = this.open(path)
    } catch (e) {
      this.deliver({ id, t: "error" })
      this.deliver({ id, t: "close", code: 1006, reason: (e as Error).message ?? "" })
      return
    }
    sock.binaryType = "arraybuffer"
    this.sockets.set(id, sock)
    const live = () => this.sockets.get(id) === sock
    sock.onopen = () => live() && this.deliver({ id, t: "open" })
    sock.onmessage = (ev) => {
      if (!live()) return
      const d = ev.data
      if (typeof d === "string") this.deliver({ id, t: "text", data: d })
      else if (d instanceof ArrayBuffer || d instanceof Uint8Array) this.deliver({ id, t: "binary", data: toBase64(d) })
    }
    sock.onerror = () => live() && this.deliver({ id, t: "error" })
    sock.onclose = (ev) => {
      if (!live()) return
      this.sockets.delete(id)
      this.deliver({ id, t: "close", code: ev.code ?? 1006, reason: ev.reason ?? "" })
    }
  }

  /** Close every socket (the page went away or is reloading). */
  closeAll() {
    for (const sock of this.sockets.values()) sock.close(1000)
    this.sockets.clear()
  }
}

/** Injected into the page before its own scripts. It replaces WebSocket for
 *  the page's own origin (others keep the browser's), and turns a Blob
 *  request body into an ArrayBuffer — a custom-scheme request carries only
 *  in-memory bodies to the app. Posts to the "harman" message handler;
 *  receives on window.__harmanWs. */
export function wsShimScript(): string {
  return `(function () {
  if (window.__harmanWs) return;
  var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.harman;
  if (!handler) return;
  function post(m) { handler.postMessage(JSON.stringify(m)); }
  function toB64(buf) {
    var u = new Uint8Array(buf), s = "";
    for (var i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(s) {
    var bin = atob(s), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  var NativeWS = window.WebSocket, sockets = {}, seq = 0;
  var STATES = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
  function Bridged(url) {
    this.url = url; this.readyState = 0; this.binaryType = "blob";
    this.protocol = ""; this.extensions = ""; this.bufferedAmount = 0;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    this._l = {}; this._id = ++seq; sockets[this._id] = this;
    post({ t: "ws-open", id: this._id, url: url });
  }
  Bridged.prototype.addEventListener = function (type, fn) { (this._l[type] = this._l[type] || []).push(fn); };
  Bridged.prototype.removeEventListener = function (type, fn) {
    var l = this._l[type]; if (l) this._l[type] = l.filter(function (f) { return f !== fn; });
  };
  Bridged.prototype._emit = function (type, ev) {
    ev.type = type; ev.target = ev.currentTarget = this;
    var self = this, h = this["on" + type];
    if (h) h.call(this, ev);
    (this._l[type] || []).slice().forEach(function (f) { f.call(self, ev); });
  };
  Bridged.prototype.send = function (d) {
    if (this.readyState !== 1) throw new DOMException("WebSocket is not open", "InvalidStateError");
    var id = this._id;
    if (typeof d === "string") post({ t: "ws-send", id: id, text: d });
    else if (d instanceof Blob) d.arrayBuffer().then(function (b) { post({ t: "ws-send", id: id, b64: toB64(b) }); });
    else if (ArrayBuffer.isView(d)) post({ t: "ws-send", id: id, b64: toB64(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)) });
    else post({ t: "ws-send", id: id, b64: toB64(d) });
  };
  Bridged.prototype.close = function (code) {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    post({ t: "ws-close", id: this._id, code: code || 1000 });
  };
  for (var k in STATES) { Bridged[k] = STATES[k]; Bridged.prototype[k] = STATES[k]; }
  function HarmanWebSocket(url, protocols) {
    var u = new URL(url, location.href);
    if (u.host === ${JSON.stringify(APP_HOST)} && (u.protocol === "ws:" || u.protocol === "wss:")) return new Bridged(u.href);
    return protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
  }
  for (var s in STATES) HarmanWebSocket[s] = STATES[s];
  HarmanWebSocket.prototype = NativeWS.prototype;
  window.WebSocket = HarmanWebSocket;
  window.__harmanWs = function (m) {
    var sock = sockets[m.id];
    if (!sock) return;
    if (m.t === "open") { sock.readyState = 1; sock._emit("open", {}); }
    else if (m.t === "text") sock._emit("message", { data: m.data });
    else if (m.t === "binary") {
      var buf = fromB64(m.data);
      sock._emit("message", { data: sock.binaryType === "arraybuffer" ? buf : new Blob([buf]) });
    }
    else if (m.t === "error") sock._emit("error", {});
    else if (m.t === "close") {
      sock.readyState = 3; delete sockets[m.id];
      sock._emit("close", { code: m.code, reason: m.reason || "", wasClean: m.code === 1000 });
    }
  };
  var nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    if (init && init.body instanceof Blob) {
      var blob = init.body, next = Object.assign({}, init), h = new Headers(init.headers || {});
      if (!h.has("content-type") && blob.type) h.set("content-type", blob.type);
      next.headers = h;
      return blob.arrayBuffer().then(function (b) { next.body = b; return nativeFetch.call(window, input, next); });
    }
    return nativeFetch.apply(window, arguments);
  };
})();`
}
