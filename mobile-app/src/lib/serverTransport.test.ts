import { test as nodeTest } from "node:test"
import assert from "node:assert/strict"
import { utf8Decode } from "./bytes.ts"
import type { AppSocket } from "./deferredSocket.ts"
import { WS_OPEN, WS_OPENED, WS_TEXT } from "./relayChannel.ts"
import { deps as relayDeps, last, route, sockets, tick } from "./relayFake.testutil.ts"
import { RELAY_FILE_MAX, ServerTransport, multipartBody, type DirectIO, type Reply } from "./serverTransport.ts"

const DIRECT = "http://10.0.0.5:8091"

const reply = (status: number, body = ""): Reply => ({ status, ok: status >= 200 && status < 300, text: async () => body })
const unreachable = () => Promise.reject(new Error("Network request failed"))

/** A fake direct route: records calls, answers per `up`. */
function directIO(opts: { up?: boolean; healthy?: boolean } = {}) {
  const calls: string[] = []
  const state = { up: opts.up ?? true, healthy: opts.healthy ?? true }
  const io: DirectIO = {
    fetch: (url, init) => {
      calls.push(`${init.method} ${url}`)
      if (!state.up) return unreachable()
      if (url.endsWith("/healthz")) return Promise.resolve(reply(200, state.healthy ? '{"ok":true}' : "<html>portal</html>"))
      return Promise.resolve(reply(200, "direct"))
    },
    upload: (url) => (calls.push(`UPLOAD ${url}`), state.up ? Promise.resolve(reply(200, "up")) : unreachable()),
    download: (url) => (calls.push(`DOWNLOAD ${url}`), state.up ? Promise.resolve(200) : unreachable()),
    socket: (url) => {
      calls.push(`WS ${url}`)
      return new FakeDirectSocket(state.up)
    },
  }
  return { io, calls, state }
}

class FakeDirectSocket implements AppSocket {
  binaryType = "blob"
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: { message?: string }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  constructor(up: boolean) {
    queueMicrotask(() => {
      if (up) {
        this.readyState = 1
        this.onopen?.({})
      } else {
        this.readyState = 3
        this.onerror?.({ message: "connection refused" })
        this.onclose?.({ code: 1006 })
      }
    })
  }
  send() {}
  close() {
    this.readyState = 3
  }
}

const files = new Map<string, Uint8Array>()
const fileIO = {
  read: async (uri: string) => files.get(uri) ?? new Uint8Array(0),
  write: async (uri: string, data: Uint8Array) => void files.set(uri, data),
}

function make(direct: string, withRelay: boolean, d = directIO()) {
  const t = new ServerTransport(
    { direct, relay: withRelay ? route : undefined },
    { direct: d.io, files: fileIO, relay: relayDeps, probeMs: 50 }
  )
  return { t, ...d }
}

/** Answer every relayed HTTP request on the newest relay socket. */
async function serveRelay(handler: (req: any, body: Uint8Array) => { status: number; body?: string | Uint8Array }) {
  await tick(5)
  last().server.http(handler)
}

const tests: Array<[string, () => Promise<void>]> = []
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn])

test("a direct-only server is fetched directly, never probed", async () => {
  const { t, calls } = make(DIRECT, false)
  const res = await t.fetch("GET", "/api/x", {})
  assert.equal(await res.text(), "direct")
  assert.deepEqual(calls, [`GET ${DIRECT}/api/x`])
})

test("a relay-only server goes through the relay", async () => {
  const before = sockets.length
  const { t, calls } = make("", true)
  const p = t.fetch("POST", "/api/y", { A: "1" }, "hi")
  await serveRelay((req, body) => {
    assert.equal(req.path, "/api/y")
    assert.equal(utf8Decode(body), "hi")
    return { status: 201, body: "relayed" }
  })
  const res = await p
  assert.equal(res.status, 201)
  assert.ok(res.ok)
  assert.equal(await res.text(), "relayed")
  assert.equal(calls.length, 0)
  assert.equal(sockets.length, before + 1)
  t.close()
})

test("with both routes, a healthy direct address wins and the probe is cached", async () => {
  const { t, calls } = make(DIRECT, true)
  await t.fetch("GET", "/api/a", {})
  await t.fetch("GET", "/api/b", {})
  assert.deepEqual(calls, [`GET ${DIRECT}/healthz`, `GET ${DIRECT}/api/a`, `GET ${DIRECT}/api/b`])
  t.close()
})

test("something else answering at the direct address (a portal) means relay", async () => {
  const { t, calls } = make(DIRECT, true, directIO({ healthy: false }))
  const p = t.fetch("GET", "/api/a", {})
  await serveRelay(() => ({ status: 200, body: "r" }))
  assert.equal(await (await p).text(), "r")
  assert.deepEqual(calls, [`GET ${DIRECT}/healthz`])
  t.close()
})

test("a GET that can't reach the direct address is retried on the relay, which then sticks", async () => {
  const d = directIO()
  const { t, calls } = make(DIRECT, true, d)
  await t.fetch("GET", "/api/warm", {}) // probe says direct
  d.state.up = false
  const p = t.fetch("GET", "/api/a", {})
  await serveRelay((req) => ({ status: 200, body: req.path }))
  assert.equal(await (await p).text(), "/api/a")
  const n = calls.length
  assert.equal(await (await t.fetch("GET", "/api/b", {})).text(), "/api/b")
  assert.equal(calls.length, n, "no new direct attempt until the next probe")
  t.close()
})

test("a POST is never repeated on the relay; the next call uses it", async () => {
  const d = directIO()
  const { t } = make(DIRECT, true, d)
  await t.fetch("GET", "/api/warm", {})
  d.state.up = false
  const before = sockets.length
  await assert.rejects(t.fetch("POST", "/api/send", {}, "msg"), /Network request failed/)
  assert.equal(sockets.length, before, "the relay was not dialed for the POST")
  const p = t.fetch("POST", "/api/send", {}, "msg")
  await serveRelay(() => ({ status: 200, body: "once" }))
  assert.equal(await (await p).text(), "once")
  t.close()
})

test("a direct-only server surfaces its transport error unchanged", async () => {
  const { t } = make(DIRECT, false, directIO({ up: false }))
  await assert.rejects(t.fetch("GET", "/api/x", {}), /Network request failed/)
})

test("no route at all is an error, not a fetch of ''", async () => {
  const { t, calls } = make("", false)
  await assert.rejects(t.fetch("GET", "/api/x", {}), /No server configured/)
  assert.equal(calls.length, 0)
})

test("a relayed upload is one multipart body; oversized files are refused before dialing", async () => {
  files.set("file:///a.png", new Uint8Array([1, 2, 3]))
  const { t } = make("", true)
  const p = t.upload("/api/fs/upload?dir=x", { Authorization: "Bearer t" }, { uri: "file:///a.png", name: 'a"b.png', type: "image/png", field: "file" })
  await serveRelay((req, body) => {
    const ct = req.headers["Content-Type"] as string
    const boundary = /boundary=(\S+)/.exec(ct)![1]
    assert.equal(req.headers.Authorization, "Bearer t")
    assert.equal(utf8Decode(body).split("\r\n")[1], 'Content-Disposition: form-data; name="file"; filename="a_b.png"', "quotes can't break the header")
    const tail = `\r\n--${boundary}--\r\n`.length
    assert.deepEqual([...body.subarray(body.length - tail - 3, body.length - tail)], [1, 2, 3], "the file bytes, intact")
    return { status: 200, body: "{}" }
  })
  assert.equal((await p).status, 200)
  files.set("file:///big", new Uint8Array(RELAY_FILE_MAX + 1))
  const before = sockets.length
  await assert.rejects(t.upload("/api/fs/upload", {}, { uri: "file:///big", name: "b", type: "x/y", field: "file" }), /Too large/)
  assert.equal(sockets.length, before)
  t.close()
})

test("multipartBody frames one part between boundaries", async () => {
  const b = utf8Decode(multipartBody({ uri: "", name: "n.txt", type: "text/plain", field: "files" }, new TextEncoder().encode("hey"), "BND"))
  assert.equal(b, '--BND\r\nContent-Disposition: form-data; name="files"; filename="n.txt"\r\nContent-Type: text/plain\r\n\r\nhey\r\n--BND--\r\n')
})

test("a relayed download lands in the destination file with its status", async () => {
  const { t } = make("", true)
  const p = t.download("/api/fs/download?path=a", {}, "file:///cache/a")
  await serveRelay(() => ({ status: 404, body: "nope" }))
  assert.equal(await p, 404)
  assert.equal(utf8Decode(files.get("file:///cache/a")!), "nope")
  t.close()
})

test("media streams from the direct URL, or is fetched into a file over the relay", async () => {
  const direct = make(DIRECT, false)
  assert.deepEqual(await direct.t.media("/api/tts?t=1", { A: "1" }, "file:///c/t.aac"), { url: `${DIRECT}/api/tts?t=1`, headers: { A: "1" }, file: false })
  const relayed = make("", true)
  const p = relayed.t.media("/api/tts?t=1", { A: "1" }, "file:///c/t.aac")
  await serveRelay((req) => (req.path.endsWith("t=1") ? { status: 200, body: "aac" } : { status: 500, body: "boom" }))
  assert.deepEqual(await p, { url: "file:///c/t.aac", headers: {}, file: true })
  await assert.rejects(relayed.t.media("/api/tts?t=2", {}, "file:///c/u.aac"), /HTTP 500/)
  relayed.t.close()
})

test("a direct socket that never opens is silently replaced by a relayed one", async () => {
  const d = directIO()
  const { t, calls } = make(DIRECT, true, d)
  await t.fetch("GET", "/api/warm", {})
  d.state.up = false
  const ws = t.openSocket("/api/voice/ws", { Authorization: "Bearer t" })
  const events: string[] = []
  ws.onopen = () => events.push("open")
  ws.onerror = (e) => events.push(`error ${e.message}`)
  ws.onmessage = (e) => events.push(`msg ${e.data}`)
  await tick(10)
  assert.ok(calls.includes(`WS ws://10.0.0.5:8091/api/voice/ws`), "http maps to ws")
  const s = last()
  const open = s.server.frames.find((f) => f.kind === WS_OPEN)!
  s.server.send(WS_OPENED, open.stream)
  s.server.send(WS_TEXT, open.stream, "hi")
  await tick()
  assert.deepEqual(events, ["open", "msg hi"], "the failed direct attempt is invisible")
  t.close()
})

test("a direct-only socket that fails reports error then close", async () => {
  const { t } = make(DIRECT, false, directIO({ up: false }))
  const ws = t.openSocket("/api/x", {})
  const events: string[] = []
  ws.onerror = (e) => events.push(`error ${e.message}`)
  ws.onclose = (e) => events.push(`close ${e.code}`)
  await tick(5)
  assert.deepEqual(events, ["error connection refused", "close 1006"])
})

test("a socket with no route at all fails like an unreachable one", async () => {
  const { t } = make("", false)
  const ws = t.openSocket("/api/x", {})
  const events: string[] = []
  ws.onerror = (e) => events.push(`error ${e.message}`)
  ws.onclose = (e) => events.push(`close ${e.code}`)
  await tick()
  assert.deepEqual(events, ["error No server configured", "close 1006"])
})

// node:test runs top-level tests one after another, which the shared fakes need.
for (const [name, fn] of tests) nodeTest(name, fn)
