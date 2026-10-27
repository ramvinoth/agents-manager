/**
 * Tests for DeferredSocket: node --experimental-strip-types src/lib/deferredSocket.test.ts
 */
import assert from "node:assert"
import { DeferredSocket, type AppSocket } from "./deferredSocket.ts"

class Fake implements AppSocket {
  binaryType = "blob"
  readyState = 0
  sent: unknown[] = []
  closes: Array<number | undefined> = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: { message?: string }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  send(d: unknown) { this.sent.push(d) }
  close(code?: number) { this.closes.push(code) }
  open() { this.readyState = 1; this.onopen?.({}) }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code, reason: "" }) }
}

let passed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
  } catch (e) {
    console.error(`✘ ${name}\n`, e)
    process.exitCode = 1
  }
}

test("forwards open, messages, send and close once attached", () => {
  const d = new DeferredSocket()
  const seen: string[] = []
  d.onopen = () => seen.push("open")
  d.onmessage = (e) => seen.push(`msg:${e.data}`)
  d.onclose = (e) => seen.push(`close:${e.code}`)
  assert.throws(() => d.send("early"), /not open/)
  const f = new Fake()
  d.attach(f)
  assert.equal(f.binaryType, "arraybuffer", "binary frames arrive as ArrayBuffer")
  f.open()
  assert.equal(d.readyState, 1)
  f.onmessage?.({ data: "hi" })
  d.send("x")
  assert.deepEqual(f.sent, ["x"])
  d.close(1000)
  assert.equal(d.readyState, 2)
  assert.deepEqual(f.closes, [1000])
  f.drop(1000)
  assert.equal(d.readyState, 3)
  assert.deepEqual(seen, ["open", "msg:hi", "close:1000"])
})

test("a socket that fails to open can be retried on another route, silently", () => {
  const d = new DeferredSocket()
  const seen: string[] = []
  d.onopen = () => seen.push("open")
  d.onerror = () => seen.push("error")
  d.onclose = () => seen.push("close")
  const direct = new Fake()
  const relay = new Fake()
  d.attach(direct, () => {
    d.attach(relay)
    return true
  })
  direct.onerror?.({ message: "unreachable" })
  direct.drop()
  assert.deepEqual(seen, [], "the failed direct attempt is invisible")
  relay.open()
  direct.onmessage?.({ data: "stale" })
  assert.deepEqual(seen, ["open"], "only the live socket speaks")
})

test("without a retry, a failed open reports its error then close", () => {
  const d = new DeferredSocket()
  const seen: string[] = []
  d.onerror = (e) => seen.push(`err:${e.message}`)
  d.onclose = (e) => seen.push(`close:${e.code}`)
  const f = new Fake()
  d.attach(f, () => false)
  f.onerror?.({ message: "refused" })
  f.drop(1006)
  assert.deepEqual(seen, ["err:refused", "close:1006"])
  const g = new Fake()
  let retries = 0
  const d2 = new DeferredSocket()
  d2.attach(g, () => (retries++, true))
  g.open()
  g.drop()
  assert.equal(retries, 0, "closing after open is not a route failure")
})

test("closing before the route is chosen closes the late socket", () => {
  const d = new DeferredSocket()
  const seen: number[] = []
  d.onclose = (e) => seen.push(e.code ?? 0)
  d.close()
  assert.equal(d.readyState, 3)
  const f = new Fake()
  d.attach(f)
  assert.equal(f.closes.length, 1)
  assert.deepEqual(seen, [1000], "onclose fires exactly once")
})

test("fail reports error then close, once", () => {
  const d = new DeferredSocket()
  const seen: string[] = []
  d.onerror = (e) => seen.push(`err:${e.message}`)
  d.onclose = (e) => seen.push(`close:${e.code}`)
  d.fail(new Error("Network request failed"))
  d.fail(new Error("again"))
  assert.deepEqual(seen, ["err:Network request failed", "close:1006"])
})

console.log(`deferredSocket: ${passed} passed`)
