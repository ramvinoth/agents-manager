/**
 *     node --experimental-strip-types src/lib/fishCall.test.ts
 */
import assert from "node:assert"
import { parseFishEvent, startFishCall, type FishAudio, type FishSocket } from "./fishCall.ts"

let passed = 0
const tests: Array<() => Promise<void>> = []
function test(name: string, fn: () => Promise<void> | void) {
  tests.push(() => run(name, fn))
}
async function run(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++ } catch (e) {
    console.error("FAIL", name, e); process.exitCode = 1
  }
}

function rig() {
  const sent: unknown[] = []
  const sock = { readyState: 1, binaryType: "", onopen: null, onmessage: null, onerror: null, onclose: null,
    send: (d: unknown) => { sent.push(d) }, close: () => { (sock as any).closed = true } } as unknown as FishSocket & { closed?: boolean }
  let frame: (b: string) => void = () => {}
  let drained: () => void = () => {}
  const log: string[] = []
  const audio: FishAudio = {
    start: async () => { log.push("start") }, stop: async () => { log.push("stop") },
    onFrame: (cb) => { frame = cb; return () => log.push("unframe") },
    onDrained: (cb) => { drained = cb; return () => log.push("undrain") },
    enqueue: (_p, r) => { log.push("enq" + r); return true }, flush: () => { log.push("flush") },
  }
  const phases: string[] = []
  const fails: string[] = []
  const h = { onPhase: (p: string) => phases.push(p), onHeard: () => {}, onReply: () => {}, onFailed: (m: string) => fails.push(m) }
  const timers = { setInterval: (() => 1) as any, clearInterval: (() => {}) as any }
  const msg = (d: unknown) => sock.onmessage!({ data: d })
  return { sent, sock, audio, log, phases, fails, h, timers, msg, frame: (b: string) => frame(b), drain: () => drained() }
}

test("parse", () => {
  assert.deepStrictEqual(parseFishEvent('{"type":"ready","sample_rate":24000}'), { type: "ready", sampleRate: 24000 })
  assert.strictEqual(parseFishEvent("nope"), null)
  assert.strictEqual(parseFishEvent(new ArrayBuffer(2)), null)
})
test("start sends history, mic goes up binary", async () => {
  const r = rig()
  await startFishCall(r.sock, r.audio, [1], r.h, r.timers)
  assert.strictEqual(r.sent[0], JSON.stringify({ type: "start", history: [1] }))
  r.frame("AAA=")
  assert.ok(r.sent[1] instanceof Uint8Array)
})
test("audio then audio_end then drain sends played", async () => {
  const r = rig()
  await startFishCall(r.sock, r.audio, [], r.h, r.timers)
  r.msg('{"type":"ready","sample_rate":24000}')
  r.msg(new Uint8Array([1, 2]).buffer)
  r.msg('{"type":"audio_end","gen":7}')
  assert.ok(!r.sent.includes('{"type":"played","gen":7}'))
  r.drain()
  assert.ok(r.sent.includes('{"type":"played","gen":7}'))
  assert.deepStrictEqual(r.phases, ["waiting", "speaking", "waiting"])
})
test("audio_end with nothing queued plays immediately", async () => {
  const r = rig()
  await startFishCall(r.sock, r.audio, [], r.h, r.timers)
  r.msg('{"type":"audio_end"}')
  assert.ok(r.sent.includes('{"type":"played"}'))
})
test("barge flushes", async () => {
  const r = rig()
  await startFishCall(r.sock, r.audio, [], r.h, r.timers)
  r.msg(new Uint8Array([1, 2]).buffer)
  r.msg('{"type":"barge"}')
  assert.ok(r.log.includes("flush"))
  assert.strictEqual(r.phases.at(-1), "waiting")
})
test("server error and socket close fail once", async () => {
  const r = rig()
  await startFishCall(r.sock, r.audio, [], r.h, r.timers)
  r.msg('{"type":"error","message":"boom"}')
  r.sock.onclose!({})
  await new Promise((res) => setTimeout(res, 5))
  assert.deepStrictEqual(r.fails, ["boom"])
  assert.ok(r.log.includes("stop"))
})
test("stop sends stop and cleans up", async () => {
  const r = rig()
  const c = await startFishCall(r.sock, r.audio, [], r.h, r.timers)
  await c.stop()
  assert.ok(r.sent.includes('{"type":"stop"}'))
  assert.ok(r.log.includes("stop") && (r.sock as any).closed)
  assert.deepStrictEqual(r.fails, [])
})
test("an odd-length audio chunk never splits a sample", async () => {
  const sizes: number[] = []
  const r = rig()
  r.audio.enqueue = (p) => { sizes.push(Buffer.from(p, "base64").length); return true }
  await startFishCall(r.sock, r.audio, [], r.h, r.timers)
  r.msg(new Uint8Array([1, 2, 3]).buffer)
  r.msg(new Uint8Array([4, 5]).buffer)
  assert.deepStrictEqual(sizes, [2, 2])
})
test("the server is told to start only after the audio engine is running (turn-1 silence)", async () => {
  const r = rig()
  let engineUp = false
  let release: () => void = () => {}
  r.audio.start = () => new Promise<void>((res) => { release = () => { engineUp = true; res() } })
  r.audio.enqueue = () => engineUp
  const call = startFishCall(r.sock, r.audio, [], r.h, r.timers)
  await new Promise((res) => setTimeout(res, 5))
  assert.ok(!r.sent.includes(JSON.stringify({ type: "start", history: [] })), "start sent before the engine was up")
  release()
  await call
  assert.strictEqual(r.sent[0], JSON.stringify({ type: "start", history: [] }))
})
test("mic frames are not sent before the server start", async () => {
  const r = rig()
  let release: () => void = () => {}
  r.audio.start = () => new Promise<void>((res) => { release = res })
  const call = startFishCall(r.sock, r.audio, [], r.h, r.timers)
  await new Promise((res) => setTimeout(res, 5))
  r.frame("AAA=")
  assert.strictEqual(r.sent.length, 0)
  release()
  await call
})
test("a chunk the engine refuses ends the call loudly instead of vanishing", async () => {
  const r = rig()
  r.audio.enqueue = () => false
  await startFishCall(r.sock, r.audio, [], r.h, r.timers)
  r.msg(new Uint8Array([1, 2]).buffer)
  await new Promise((res) => setTimeout(res, 5))
  assert.strictEqual(r.fails.length, 1)
})
async function main() {
  for (const t of tests) await t()
  console.log(`${passed} passed`)
}
void main()
