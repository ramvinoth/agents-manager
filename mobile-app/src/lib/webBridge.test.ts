import { test } from "node:test"
import assert from "node:assert/strict"
import { utf8Decode, utf8Encode } from "./bytes.ts"
import type { AppSocket } from "./deferredSocket.ts"
import type { RawReply } from "./serverTransport.ts"
import {
  AssetCache,
  SocketBridge,
  answer,
  bridgePath,
  externalUrl,
  isImmutable,
  parseOpenRef,
  parsePageMessage,
  requestHeaders,
  responseHeaders,
  wsShimScript,
  type SocketEvent,
} from "./webBridge.ts"

const raw = (status: number, text: string, headers: Record<string, string> = {}): RawReply => ({ status, headers, body: utf8Encode(text) })

test("bridgePath keeps only the page's own origin", () => {
  assert.equal(bridgePath("harman://app/?canvasSession=s1&embed=1"), "/?canvasSession=s1&embed=1")
  assert.equal(bridgePath("harman://app"), "/")
  assert.equal(bridgePath("ws://app/api/canvas/ws?p=1"), "/api/canvas/ws?p=1")
  assert.equal(bridgePath("wss://APP/api/x#frag"), "/api/x")
  assert.equal(bridgePath("https://example.com/api/x"), null)
  assert.equal(bridgePath("harman://evil/api/x"), null)
  assert.equal(bridgePath("file://app/etc/passwd"), null)
  assert.equal(bridgePath("not a url"), null)
})

test("request headers: no cookies, plain body, wire headers dropped", () => {
  const h = requestHeaders({ Cookie: "viewer_session=x", "Accept-Encoding": "gzip", Accept: "text/html", "Content-Type": "image/png", Origin: "harman://app" })
  assert.deepEqual(h, { "accept-encoding": "identity", accept: "text/html", "content-type": "image/png" })
})

test("response headers: encoding, length and cookies dropped", () => {
  const h = responseHeaders({ "Content-Encoding": "gzip", "content-length": "9", "set-cookie": "a=b", "content-type": "text/html", "cache-control": "no-store" })
  assert.deepEqual(h, { "content-type": "text/html", "cache-control": "no-store" })
})

test("isImmutable: hashed build output only", () => {
  assert.ok(isImmutable("/assets/index-abc.js"))
  assert.ok(isImmutable("/excalidraw-assets/Virgil.woff2"))
  assert.ok(!isImmutable("/"))
  assert.ok(!isImmutable("/api/assets/x"))
})

test("AssetCache evicts least-recently-used past the budget, refuses huge files", () => {
  const c = new AssetCache(40)
  c.put("a", raw(200, "aaaaaaaaaa"))
  c.put("b", raw(200, "bbbbbbbbbb"))
  c.put("c", raw(200, "cccccccccc"))
  assert.ok(c.get("a")) // a is now most recent
  c.put("d", raw(200, "dddddddddd"))
  c.put("e", raw(200, "eeeeeeeeee")) // over 40: evict b (oldest)
  assert.equal(c.get("b"), undefined)
  assert.ok(c.get("a") && c.get("e"))
  assert.equal(c.size, 40)
  c.put("huge", raw(200, "x".repeat(11)))
  assert.equal(c.get("huge"), undefined)
  c.put("a", raw(200, "a")) // replace shrinks
  assert.equal(c.size, 31)
})

test("answer caches immutable GET 200s per server, passes everything else through", async () => {
  const calls: string[] = []
  const exchange = async (method: string, path: string, headers: Record<string, string>, body?: Uint8Array) => {
    calls.push(`${method} ${path} ${headers["accept-encoding"]} ${body ? utf8Decode(body) : ""}`)
    if (path === "/assets/missing.js") return raw(404, "no")
    return raw(200, "ok", { "content-encoding": "gzip", "content-type": "text/javascript" })
  }
  const cache = new AssetCache(1 << 20)
  const r1 = await answer({ method: "get", path: "/assets/a.js", headers: {} }, exchange, cache, "s1")
  assert.deepEqual(r1.headers, { "content-type": "text/javascript" })
  await answer({ method: "GET", path: "/assets/a.js", headers: {} }, exchange, cache, "s1")
  await answer({ method: "GET", path: "/assets/a.js", headers: {} }, exchange, cache, "s2")
  await answer({ method: "GET", path: "/assets/missing.js", headers: {} }, exchange, cache, "s1")
  await answer({ method: "GET", path: "/assets/missing.js", headers: {} }, exchange, cache, "s1")
  await answer({ method: "POST", path: "/api/canvas/files", headers: {}, body: utf8Encode("img") }, exchange, cache, "s1")
  await answer({ method: "GET", path: "/", headers: {} }, exchange, cache, "s1")
  await answer({ method: "GET", path: "/", headers: {} }, exchange, cache, "s1")
  assert.deepEqual(calls, [
    "GET /assets/a.js identity ",
    "GET /assets/a.js identity ",
    "GET /assets/missing.js identity ",
    "GET /assets/missing.js identity ",
    "POST /api/canvas/files identity img",
    "GET / identity ",
    "GET / identity ",
  ])
})

test("parsePageMessage rejects anything malformed", () => {
  assert.deepEqual(parsePageMessage('{"t":"ws-open","id":1,"url":"ws://app/api/x"}'), { t: "ws-open", id: 1, url: "ws://app/api/x" })
  assert.deepEqual(parsePageMessage('{"t":"ws-send","id":1,"text":"hi"}'), { t: "ws-send", id: 1, text: "hi" })
  assert.deepEqual(parsePageMessage('{"t":"ws-send","id":1,"b64":"AQI="}'), { t: "ws-send", id: 1, b64: "AQI=" })
  assert.deepEqual(parsePageMessage('{"t":"ws-close","id":2}'), { t: "ws-close", id: 2, code: undefined })
  for (const bad of ["", "nope", "null", "[]", '{"t":"ws-open","id":"1","url":"x"}', '{"t":"ws-send","id":1}', '{"t":"other","id":1}']) {
    assert.equal(parsePageMessage(bad), null, bad)
  }
})

class FakeSocket implements AppSocket {
  binaryType = "blob"
  readyState = 0
  sent: unknown[] = []
  closed: number | undefined
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: { message?: string }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  readonly path: string
  constructor(path: string) {
    this.path = path
  }
  send(d: string | ArrayBuffer | Uint8Array) {
    this.sent.push(d)
  }
  close(code?: number) {
    this.closed = code
  }
}

function bridge() {
  const opened: FakeSocket[] = []
  const events: SocketEvent[] = []
  const b = new SocketBridge(
    (path) => {
      const s = new FakeSocket(path)
      opened.push(s)
      return s
    },
    (ev) => events.push(ev)
  )
  return { b, opened, events }
}

test("SocketBridge opens through the transport and relays both ways", () => {
  const { b, opened, events } = bridge()
  b.handle({ t: "ws-open", id: 7, url: "ws://app/api/canvas/ws?p=3" })
  const s = opened[0]
  assert.equal(s.path, "/api/canvas/ws?p=3")
  assert.equal(s.binaryType, "arraybuffer")
  s.onopen!({})
  s.onmessage!({ data: "hello" })
  s.onmessage!({ data: new Uint8Array([1, 2]).buffer })
  b.handle({ t: "ws-send", id: 7, text: "up" })
  b.handle({ t: "ws-send", id: 7, b64: "AwQ=" })
  assert.equal(s.sent[0], "up")
  assert.deepEqual([...(s.sent[1] as Uint8Array)], [3, 4])
  s.onclose!({ code: 1001, reason: "bye" })
  s.onmessage!({ data: "late" }) // after close: ignored
  assert.deepEqual(events, [
    { id: 7, t: "open" },
    { id: 7, t: "text", data: "hello" },
    { id: 7, t: "binary", data: "AQI=" },
    { id: 7, t: "close", code: 1001, reason: "bye" },
  ])
})

test("SocketBridge refuses sockets off /api/ or off the page origin", () => {
  const { b, opened, events } = bridge()
  b.handle({ t: "ws-open", id: 1, url: "ws://app/other" })
  b.handle({ t: "ws-open", id: 2, url: "wss://elsewhere.com/api/x" })
  assert.equal(opened.length, 0)
  assert.deepEqual(events.map((e) => `${e.id}:${e.t}`), ["1:error", "1:close", "2:error", "2:close"])
})

test("SocketBridge page close and closeAll close the real sockets once", () => {
  const { b, opened, events } = bridge()
  b.handle({ t: "ws-open", id: 1, url: "ws://app/api/a" })
  b.handle({ t: "ws-open", id: 2, url: "ws://app/api/b" })
  b.handle({ t: "ws-close", id: 1, code: 4000 })
  assert.equal(opened[0].closed, 4000)
  opened[0].onclose!({ code: 4000 }) // the real close event after: not delivered twice
  assert.deepEqual(events, [{ id: 1, t: "close", code: 4000, reason: "" }])
  b.closeAll()
  assert.equal(opened[1].closed, 1000)
  b.handle({ t: "ws-send", id: 2, text: "x" }) // gone: ignored
  assert.equal(opened[1].sent.length, 0)
})

test("SocketBridge reports an open that throws", () => {
  const events: SocketEvent[] = []
  const b = new SocketBridge(() => {
    throw new Error("No server configured")
  }, (ev) => events.push(ev))
  b.handle({ t: "ws-open", id: 3, url: "ws://app/api/x" })
  assert.deepEqual(events, [{ id: 3, t: "error" }, { id: 3, t: "close", code: 1006, reason: "No server configured" }])
})

test("the shim parses as a script and names the page host", () => {
  const src = wsShimScript()
  assert.doesNotThrow(() => new Function(src))
  assert.match(src, /u\.host === "app"/)
})

test("parseOpenRef: tile links the page asks the app to open", () => {
  const open = (o: unknown) => parseOpenRef(JSON.stringify(o))
  assert.deepEqual(open({ t: "open", kind: "card", id: "12" }), { kind: "card", id: 12 })
  assert.deepEqual(open({ t: "open", kind: "note", id: "7" }), { kind: "note", id: 7 })
  assert.deepEqual(open({ t: "open", kind: "sift", id: "doc-1" }), { kind: "sift", id: "doc-1" })
  assert.deepEqual(open({ t: "open", kind: "inbox", id: "41" }), { kind: "inbox", id: "41" })
  // Card and note ids are positive integers; unknown kinds and socket traffic are not refs.
  for (const bad of [
    { t: "open", kind: "card", id: "0" },
    { t: "open", kind: "card", id: "1e3" },
    { t: "open", kind: "note", id: "-2" },
    { t: "open", kind: "card", id: 12 },
    { t: "open", kind: "file", id: "x" },
    { t: "open", kind: "sift", id: "" },
    { t: "open", kind: "code", id: "orchestrator/db.py" },
    { t: "ws-open", id: 1, url: "/api/x" },
  ]) assert.equal(open(bad), null, JSON.stringify(bad))
  assert.equal(parseOpenRef("not json"), null)
  assert.equal(parseOpenRef("null"), null)
})

test("externalUrl: web, mail and phone only; an empty window.open is dropped", () => {
  assert.equal(externalUrl("https://example.com/a"), "https://example.com/a")
  assert.equal(externalUrl(" mailto:a@b.c "), "mailto:a@b.c")
  assert.equal(externalUrl("tel:+15550100"), "tel:+15550100")
  for (const bad of ["", "   ", undefined, null, 42, "about:blank", "javascript:alert(1)", "file:///etc/passwd", "harman://doc/x", "https://"])
    assert.equal(externalUrl(bad), null, String(bad))
})
