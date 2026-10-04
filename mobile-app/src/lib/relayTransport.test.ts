import { test as nodeTest } from "node:test"
import assert from "node:assert/strict"
import { utf8Decode } from "./bytes.ts"
import {
  CANCEL, ERROR, HTTP_BODY, HTTP_END, HTTP_REQ, RES_BODY, RES_END, RES_HEAD,
  WS_BINARY, WS_CLOSE, WS_OPEN, WS_OPENED, WS_TEXT, CHUNK,
} from "./relayChannel.ts"
import { MAX_STREAMS, RelayLink, RouteChooser, TooLargeError, relaySocketUrl } from "./relayTransport.ts"
import { deps, hello, last, route, sockets, tick } from "./relayFake.testutil.ts"

const tests: Array<[string, () => Promise<void>]> = []
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn])

test("socket URL maps https to wss and addresses the server as a client", async () => {
  assert.equal(relaySocketUrl(route), "wss://relay.example/ws?serverId=abcdefghijklmnop1234&role=client")
  assert.equal(relaySocketUrl({ ...route, url: "wss://r.example/" }), "wss://r.example/ws?serverId=abcdefghijklmnop1234&role=client")
})

test("fetch round-trips a request with a chunked body over one connection", async () => {
  const link = new RelayLink(route, deps)
  const big = new Uint8Array(CHUNK * 2 + 5).fill(7)
  const p = link.fetch({ method: "POST", path: "/api/x", headers: { A: "1" }, body: big })
  await tick()
  last().server.http((req, body) => {
    if (req.path === "/api/x") {
      assert.deepEqual(req, { method: "POST", path: "/api/x", headers: { A: "1", "Content-Length": String(big.length) } }, "the size travels as Content-Length")
      assert.equal(body.length, big.length)
    }
    return { status: 201, headers: { "Content-Type": "text/plain" }, body: "ok" }
  })
  const res = await p
  assert.equal(res.status, 201)
  assert.equal(res.headers["content-type"], "text/plain", "header names are lower-cased")
  assert.equal(utf8Decode(res.body), "ok")
  assert.equal(last().binaryType, "arraybuffer")
  const before = sockets.length
  const again = await link.fetch({ method: "GET", path: "/healthz", headers: {} })
  assert.equal(again.status, 201)
  assert.equal(sockets.length, before, "the connection is reused")
  const ids = last().server.frames.filter((f) => f.kind === HTTP_REQ).map((f) => f.stream)
  assert.deepEqual(ids, [1, 2], "stream ids count up and are never reused")
  assert.equal(last().server.frames.filter((f) => f.kind === HTTP_BODY).length, 3, "body split at CHUNK")
  link.close()
})

test("hello is repeated until the server answers, then the request flows", async () => {
  const link = new RelayLink(route, deps)
  hello.answer = false
  const p = link.fetch({ method: "GET", path: "/a", headers: {} })
  hello.answer = true
  await tick(25)
  assert.ok(last().server.hellos >= 2, "hello resent while unanswered")
  last().answerHello = true
  last().server.http(() => ({ status: 200, body: "late" }))
  assert.equal(utf8Decode((await p).body), "late")
  link.close()
})

test("a handshake that never completes fails as a transport error", async () => {
  const link = new RelayLink(route, { ...deps, handshakeMs: 30 })
  hello.answer = false
  const p = link.fetch({ method: "GET", path: "/a", headers: {} })
  hello.answer = true
  await assert.rejects(p, /Network request failed \(relay handshake timed out\)/)
  link.close()
})

test("server ERROR rejects with a transport-shaped message", async () => {
  const link = new RelayLink(route, deps)
  const p = link.fetch({ method: "GET", path: "/a", headers: {} })
  await tick()
  last().server.onFrame = (f) => f.kind === HTTP_END && last().server.send(ERROR, f.stream, "server error: refused")
  last().server.replay()
  await assert.rejects(p, /^Error: Network request failed \(relay: server error: refused\)$/)
  link.close()
})

test("a dropped connection fails in-flight requests and the next one redials", async () => {
  const link = new RelayLink(route, deps)
  const p = link.fetch({ method: "GET", path: "/a", headers: {} })
  await tick()
  const first = last()
  first.close(1012)
  await assert.rejects(p, /Network request failed \(relay closed 1012\)/)
  const q = link.fetch({ method: "GET", path: "/b", headers: {} })
  await tick()
  assert.notEqual(last(), first, "a fresh connection")
  last().server.http(() => ({ status: 200, body: "b" }))
  assert.equal(utf8Decode((await q).body), "b")
  link.close()
})

test("a forged or reordered server frame kills the connection", async () => {
  const link = new RelayLink(route, deps)
  const p = link.fetch({ method: "GET", path: "/a", headers: {} })
  await tick()
  const s = last()
  s.server.onFrame = (f) => {
    if (f.kind !== HTTP_END) return
    s.server.tx = 5 // skip ahead: an out-of-order nonce
    s.server.send(RES_END, f.stream)
  }
  s.server.replay()
  await assert.rejects(p, /unexpected nonce/)
  assert.equal(s.readyState, 3)
  link.close()
})

test("an oversized response is cancelled and rejects with TooLargeError", async () => {
  const link = new RelayLink(route, deps)
  const p = link.fetch({ method: "GET", path: "/big", headers: {} }, 10)
  await tick()
  const s = last()
  s.server.onFrame = (f) => {
    if (f.kind !== HTTP_END) return
    s.server.send(RES_HEAD, f.stream, JSON.stringify({ status: 200, headers: {} }))
    s.server.send(RES_BODY, f.stream, new Uint8Array(11))
  }
  s.server.replay()
  await assert.rejects(p, TooLargeError)
  await tick()
  assert.ok(s.server.frames.some((f) => f.kind === CANCEL), "server told to stop")
  link.close()
})

test("more than MAX_STREAMS requests wait for a slot instead of being refused", async () => {
  const link = new RelayLink(route, deps)
  const all = Array.from({ length: MAX_STREAMS + 3 }, (_, i) => link.fetch({ method: "GET", path: `/${i}`, headers: {} }))
  await tick(5)
  const s = last()
  const reqs = () => s.server.frames.filter((f) => f.kind === HTTP_REQ)
  assert.equal(reqs().length, MAX_STREAMS)
  // answering the ones already sent frees slots; the waiting three then go out
  s.server.http(() => ({ status: 200 }))
  const res = await Promise.all(all)
  assert.equal(res.length, MAX_STREAMS + 3)
  assert.equal(reqs().length, MAX_STREAMS + 3)
  link.close()
})

test("RelaySocket opens, carries text and binary both ways, and closes", async () => {
  const link = new RelayLink(route, deps)
  const ws = link.openSocket("/api/voice/ws?mode=call", { Authorization: "Bearer t" })
  const got: unknown[] = []
  let opened = false
  let closed: number | null = null
  ws.onopen = () => (opened = true)
  ws.onmessage = (e) => got.push(e.data)
  ws.onclose = (e) => (closed = e.code ?? null)
  assert.equal(ws.readyState, 0)
  assert.throws(() => ws.send("early"), /not open/)
  await tick(5)
  const s = last()
  const open = s.server.frames.find((f) => f.kind === WS_OPEN)!
  assert.deepEqual(JSON.parse(utf8Decode(open.payload)), { path: "/api/voice/ws?mode=call", headers: { Authorization: "Bearer t" } })
  s.server.send(WS_OPENED, open.stream)
  await tick()
  assert.ok(opened)
  assert.equal(ws.readyState, 1)
  ws.send("hi")
  ws.send(new Uint8Array([1, 2]).buffer)
  s.server.send(WS_TEXT, open.stream, "yo")
  s.server.send(WS_BINARY, open.stream, new Uint8Array([9]))
  await tick()
  const sent = s.server.frames.filter((f) => f.stream === open.stream)
  assert.equal(utf8Decode(sent.find((f) => f.kind === WS_TEXT)!.payload), "hi")
  assert.deepEqual([...sent.find((f) => f.kind === WS_BINARY)!.payload], [1, 2])
  assert.equal(got[0], "yo")
  assert.ok(got[1] instanceof ArrayBuffer)
  assert.deepEqual([...new Uint8Array(got[1] as ArrayBuffer)], [9])
  s.server.send(WS_CLOSE, open.stream, new Uint8Array([0x03, 0xe8]))
  await tick()
  assert.equal(closed, 1000)
  assert.equal(ws.readyState, 3)
  link.close()
})

test("RelaySocket refused by the server errors then closes 1006", async () => {
  const link = new RelayLink(route, deps)
  const ws = link.openSocket("/api/x", {})
  let err = ""
  let closed = 0
  ws.onerror = (e) => (err = e.message || "")
  ws.onclose = (e) => (closed = e.code ?? 0)
  await tick(5)
  const open = last().server.frames.find((f) => f.kind === WS_OPEN)!
  last().server.send(ERROR, open.stream, "websocket refused (401)")
  await tick()
  assert.equal(err, "websocket refused (401)")
  assert.equal(closed, 1006)
  link.close()
})

test("closing a RelaySocket tells the server and a dropped link closes open sockets", async () => {
  const link = new RelayLink(route, deps)
  const a = link.openSocket("/api/a", {})
  const b = link.openSocket("/api/b", {})
  await tick(5)
  const s = last()
  for (const f of s.server.frames.filter((f) => f.kind === WS_OPEN)) s.server.send(WS_OPENED, f.stream)
  await tick()
  a.close()
  const closeFrame = s.server.frames.find((f) => f.kind === WS_CLOSE)!
  assert.deepEqual([...closeFrame.payload], [0x03, 0xe8])
  let bClosed = 0
  b.onclose = (e) => (bClosed = e.code ?? 0)
  s.close(1012)
  await tick()
  assert.equal(bClosed, 1006)
  link.close()
})

test("a closed link refuses new work", async () => {
  const link = new RelayLink(route, deps)
  link.close()
  await assert.rejects(link.fetch({ method: "GET", path: "/", headers: {} }), /link closed/)
})

test("RouteChooser probes once, caches, and falls back after a direct failure", async () => {
  let probes = 0
  let up = true
  let now = 0
  const rc = new RouteChooser(async () => (probes++, up), () => now, 1000)
  assert.equal(await Promise.all([rc.useDirect(), rc.useDirect()]).then((v) => v.join()), "true,true")
  assert.equal(probes, 1, "concurrent callers share one probe")
  rc.directFailed()
  assert.equal(await rc.useDirect(), false)
  assert.equal(probes, 1)
  now = 2000
  up = false
  assert.equal(await rc.useDirect(), false)
  assert.equal(probes, 2, "re-probed after the TTL")
  const failing = new RouteChooser(async () => { throw new Error("x") })
  assert.equal(await failing.useDirect(), false, "a throwing probe means relay")
})

// node:test runs top-level tests one after another, which the shared fakes need.
for (const [name, fn] of tests) nodeTest(name, fn)
