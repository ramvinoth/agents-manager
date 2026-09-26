/**
 * Tests for NemotronCall — the phone side of the viewer's turn-based call WS.
 *
 * Runs in plain Node, no simulator:
 *     node --experimental-strip-types src/lib/nemotron.test.ts
 *
 * Proves the wire contract the call screen relies on (binary reply BEFORE its
 * turn_end; a turn without audio fails, never degrades to text) and the
 * teardown rules (idle disconnect reaches onDown once; timeout closes the call;
 * a late save is deleted, not resolved).
 */
import assert from "node:assert"
import { NemotronCall, NEMOTRON_OPEN, type NemotronBindings, type NemotronSocket } from "./nemotron.ts"

class FakeSocket implements NemotronSocket {
  readyState = NEMOTRON_OPEN
  sent: ArrayBuffer[] = []
  closed = 0
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  send(data: ArrayBuffer) { this.sent.push(data) }
  close() { this.closed++; this.readyState = 3 }
  text(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }) }
  binary(buf: ArrayBuffer) { this.onmessage?.({ data: buf }) }
}

function harness(saveResult: string | null = "file:///reply.wav") {
  const sock = new FakeSocket()
  const deleted: string[] = []
  let saves = 0
  const bindings: NemotronBindings = {
    openSocket: () => sock,
    saveAudio: async () => { saves++; return saveResult },
    deleteAudio: async (uri) => { deleted.push(uri) },
  }
  const call = new NemotronCall(bindings)
  const downs: string[] = []
  call.onDown = (e) => downs.push(e.message)
  return { sock, call, downs, deleted, saves: () => saves }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

let passed = 0
const tests: Promise<void>[] = []
function test(name: string, fn: () => Promise<void> | void) {
  tests.push(Promise.resolve().then(fn).then(
    () => { passed++ },
    (e) => { console.error(`✘ ${name}\n`, e); process.exitCode = 1 }
  ))
}

test("connect resolves on ready; audio before turn_end resolves a turn", async () => {
  const h = harness()
  const connected = h.call.connect("ws://x", {})
  assert.equal(h.call.isReady, false)
  h.sock.text({ kind: "ready" })
  await connected
  assert.equal(h.call.isReady, true)
  const turn = h.call.sendTurn(new ArrayBuffer(4))
  assert.equal(h.sock.sent.length, 1)
  h.sock.binary(new ArrayBuffer(8))
  h.sock.text({ kind: "turn_end", text: "hello" })
  const res = await turn
  assert.deepEqual(res, { text: "hello", audioUri: "file:///reply.wav" })
  assert.deepEqual(h.downs, [])
})

test("a turn_end with no audio rejects — never a text-only success", async () => {
  const h = harness()
  const c = h.call.connect("ws://x", {}); h.sock.text({ kind: "ready" }); await c
  const turn = h.call.sendTurn(new ArrayBuffer(4))
  h.sock.text({ kind: "turn_end", text: "hello" })
  await assert.rejects(turn, /without reply audio/)
  assert.equal(h.call.isReady, true, "the call itself stays usable")
})

test("a failed save rejects the turn", async () => {
  const h = harness(null)
  const c = h.call.connect("ws://x", {}); h.sock.text({ kind: "ready" }); await c
  const turn = h.call.sendTurn(new ArrayBuffer(4))
  h.sock.binary(new ArrayBuffer(8))
  h.sock.text({ kind: "turn_end", text: "hi" })
  await assert.rejects(turn, /Could not save/)
})

test("only one turn in flight; second sendTurn rejects without sending", async () => {
  const h = harness()
  const c = h.call.connect("ws://x", {}); h.sock.text({ kind: "ready" }); await c
  const first = h.call.sendTurn(new ArrayBuffer(1))
  await assert.rejects(h.call.sendTurn(new ArrayBuffer(1)), /already in flight/)
  assert.equal(h.sock.sent.length, 1)
  h.sock.binary(new ArrayBuffer(1)); h.sock.text({ kind: "turn_end", text: "" })
  await first
})

test("service error mid-turn rejects that turn only", async () => {
  const h = harness()
  const c = h.call.connect("ws://x", {}); h.sock.text({ kind: "ready" }); await c
  const turn = h.call.sendTurn(new ArrayBuffer(1))
  h.sock.text({ kind: "error", message: "GPU call slot is occupied" })
  await assert.rejects(turn, /slot is occupied/)
  assert.deepEqual(h.downs, [])
})

test("idle disconnect fires onDown exactly once and leaves the call not ready", async () => {
  const h = harness()
  const c = h.call.connect("ws://x", {}); h.sock.text({ kind: "ready" }); await c
  h.sock.onclose?.({})
  h.sock.onerror?.({})
  assert.deepEqual(h.downs, ["Nemotron connection closed"])
  assert.equal(h.call.isReady, false)
  await assert.rejects(h.call.sendTurn(new ArrayBuffer(1)), /not connected/)
})

test("error before ready rejects connect and fires onDown once", async () => {
  const h = harness()
  const c = h.call.connect("ws://x", {})
  h.sock.text({ kind: "error", message: "busy" })
  await assert.rejects(c, /busy/)
  h.sock.onclose?.({})
  assert.equal(h.downs.length, 1)
})

test("turn timeout closes the socket; a late reply is dropped and its file deleted", async () => {
  const h = harness()
  const c = h.call.connect("ws://x", {}); h.sock.text({ kind: "ready" }); await c
  const turn = h.call.sendTurn(new ArrayBuffer(1), 5)
  await assert.rejects(turn, /timed out/)
  assert.equal(h.sock.closed, 1)
  assert.deepEqual(h.downs, ["Nemotron turn timed out"])
  // A straggling reply for the dead turn must not resolve anything.
  h.sock.binary(new ArrayBuffer(1)); h.sock.text({ kind: "turn_end", text: "late" })
  await tick()
  assert.equal(h.saves(), 0)
})

test("close() during an in-flight save deletes the file instead of leaking it", async () => {
  const h = harness()
  const c = h.call.connect("ws://x", {}); h.sock.text({ kind: "ready" }); await c
  const turn = h.call.sendTurn(new ArrayBuffer(1))
  h.sock.binary(new ArrayBuffer(1)); h.sock.text({ kind: "turn_end", text: "x" })
  h.call.close() // save is still pending (microtask)
  await assert.rejects(turn, /closed/)
  await tick(); await tick()
  assert.deepEqual(h.deleted, ["file:///reply.wav"])
  assert.equal(h.sock.closed, 1)
})

test("close() is idempotent and onDown fires once", async () => {
  const h = harness()
  const c = h.call.connect("ws://x", {}); h.sock.text({ kind: "ready" }); await c
  h.call.close(); h.call.close()
  assert.equal(h.downs.length, 1)
})

test("malformed and unknown frames are ignored", async () => {
  const h = harness()
  const c = h.call.connect("ws://x", {})
  h.sock.onmessage?.({ data: "{not json" })
  h.sock.text({ kind: "transcript_delta", text: "…" })
  h.sock.text(null)
  h.sock.text({ kind: "ready" })
  await c
  assert.equal(h.call.isReady, true)
})

Promise.all(tests).then(() => {
  if (process.exitCode) return
  console.log(`✔ nemotron: ${passed} passing`)
})
