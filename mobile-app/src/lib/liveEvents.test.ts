import { test } from "node:test"
import assert from "node:assert/strict"
import {
  Backoff,
  LINGER_MS,
  LiveStream,
  RECONNECT_MS,
  STALE_MS,
  parseLiveEvent,
  serialize,
  startLiveRefresh,
  type LiveEvent,
  type Timers,
} from "./liveEvents.ts"
import type { AppSocket } from "./deferredSocket.ts"

/** A virtual clock: timers fire only when advance() passes them. */
function fakeClock() {
  let now = 0
  let seq = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  const timers: Timers = {
    setTimeout(fn, ms) {
      const id = ++seq
      pending.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout(h) {
      pending.delete(h as number)
    },
  }
  async function advance(ms: number) {
    const end = now + ms
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null
      for (const e of pending) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e
      if (!next) break
      pending.delete(next[0])
      now = next[1].at
      next[1].fn()
      await flush()
    }
    now = end
    await flush()
  }
  return { timers, advance, pendingCount: () => pending.size }
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

class FakeSocket implements AppSocket {
  binaryType = "arraybuffer"
  readyState = 0
  closed = false
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: { message?: string }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  send() {}
  close() {
    this.closed = true
    this.readyState = 3
  }
  frame(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
  drop() {
    this.readyState = 3
    this.onclose?.({ code: 1006 })
  }
}

function streamWith(clock = fakeClock()) {
  const sockets: FakeSocket[] = []
  const stream = new LiveStream(() => {
    const s = new FakeSocket()
    sockets.push(s)
    return s
  }, clock.timers)
  return { stream, sockets, clock }
}

// ---- parse ----------------------------------------------------------------------

test("parseLiveEvent accepts the server's events and rejects the rest", () => {
  assert.deepEqual(parseLiveEvent('{"type":"list-changed"}'), { type: "list-changed" })
  assert.deepEqual(parseLiveEvent('{"type":"turn-end","session":"s"}'), { type: "turn-end", session: "s" })
  assert.equal(parseLiveEvent('{"type":"turn-end"}'), null) // session event without a session
  assert.equal(parseLiveEvent('{"type":"ping"}'), null)
  assert.equal(parseLiveEvent('{"type":"hello"}'), null)
  assert.equal(parseLiveEvent('{"type":"from-the-future"}'), null)
  assert.equal(parseLiveEvent("not json"), null)
  assert.equal(parseLiveEvent(new ArrayBuffer(2)), null)
  assert.equal(parseLiveEvent("null"), null)
})

// ---- Backoff ----------------------------------------------------------------------

test("Backoff walks the steps, holds the last, and resets", () => {
  const b = new Backoff([4000, 10000, 30000])
  assert.deepEqual([b.next(), b.next(), b.next(), b.next()], [4000, 10000, 30000, 30000])
  b.reset()
  assert.equal(b.next(), 4000)
})

// ---- LiveStream -------------------------------------------------------------------

test("live only after hello; events reach listeners", () => {
  const { stream, sockets } = streamWith()
  const seen: LiveEvent[] = []
  const lives: boolean[] = []
  stream.subscribe({ onEvent: (e) => seen.push(e), onLive: (l) => lives.push(l) })
  assert.equal(sockets.length, 1)
  assert.equal(stream.live, false)
  sockets[0].frame({ type: "hello" })
  assert.equal(stream.live, true)
  sockets[0].frame({ type: "ping" })
  sockets[0].frame({ type: "transcript-changed", session: "s", size: 9, uuid: "u" })
  assert.deepEqual(seen, [{ type: "transcript-changed", session: "s", size: 9, uuid: "u" }])
  assert.deepEqual(lives, [true])
})

test("one socket for every subscriber", () => {
  const { stream, sockets } = streamWith()
  stream.subscribe({})
  stream.subscribe({})
  assert.equal(sockets.length, 1)
})

test("a drop reports not-live and reconnects on the backoff", async () => {
  const { stream, sockets, clock } = streamWith()
  const lives: boolean[] = []
  stream.subscribe({ onLive: (l) => lives.push(l) })
  sockets[0].frame({ type: "hello" })
  sockets[0].drop()
  assert.deepEqual(lives, [true, false])
  await clock.advance(RECONNECT_MS[0] - 1)
  assert.equal(sockets.length, 1)
  await clock.advance(1)
  assert.equal(sockets.length, 2)
  sockets[1].drop() // never greeted: the next wait is longer
  await clock.advance(RECONNECT_MS[1] - 1)
  assert.equal(sockets.length, 2)
  await clock.advance(1)
  assert.equal(sockets.length, 3)
  sockets[2].frame({ type: "hello" }) // a hello resets the backoff
  sockets[2].drop()
  await clock.advance(RECONNECT_MS[0])
  assert.equal(sockets.length, 4)
})

test("an old server that never says hello stays not-live (clients keep polling)", async () => {
  const { stream, sockets, clock } = streamWith()
  stream.subscribe({})
  sockets[0].drop() // 404 → the socket closes without opening
  await clock.advance(120000)
  assert.equal(stream.live, false)
  assert.ok(sockets.length >= 3 && sockets.length <= 6) // backing off, not hammering
})

test("a silent socket is declared dead after STALE_MS", async () => {
  const { stream, sockets, clock } = streamWith()
  stream.subscribe({})
  sockets[0].frame({ type: "hello" })
  await clock.advance(STALE_MS - 1)
  sockets[0].frame({ type: "ping" }) // a frame re-arms the timer
  await clock.advance(STALE_MS - 1)
  assert.equal(stream.live, true)
  await clock.advance(1)
  assert.equal(stream.live, false)
  assert.equal(sockets[0].closed, true)
})

test("a stale socket's late close does not touch its replacement", async () => {
  const { stream, sockets, clock } = streamWith()
  stream.subscribe({})
  sockets[0].frame({ type: "hello" })
  await clock.advance(STALE_MS) // declared dead
  await clock.advance(RECONNECT_MS[0])
  sockets[1].frame({ type: "hello" })
  sockets[0].drop() // its close event arrives late
  assert.equal(stream.live, true)
  sockets[0].frame({ type: "list-changed" })
})

test("lingers after the last unsubscribe, then closes", async () => {
  const { stream, sockets, clock } = streamWith()
  const off = stream.subscribe({})
  sockets[0].frame({ type: "hello" })
  off()
  off() // idempotent
  await clock.advance(LINGER_MS - 1)
  stream.subscribe({}) // a new screen within the linger keeps the socket
  await clock.advance(LINGER_MS)
  assert.equal(sockets.length, 1)
  assert.equal(sockets[0].closed, false)
})

test("closes once nobody is back within the linger, and reopens on demand", async () => {
  const { stream, sockets, clock } = streamWith()
  const off = stream.subscribe({})
  sockets[0].frame({ type: "hello" })
  off()
  await clock.advance(LINGER_MS)
  assert.equal(sockets[0].closed, true)
  assert.equal(stream.live, false)
  assert.equal(clock.pendingCount(), 0) // no retry, no stale timer left behind
  stream.subscribe({})
  assert.equal(sockets.length, 2)
})

test("an open() that throws is retried like a drop", async () => {
  const clock = fakeClock()
  let calls = 0
  const stream = new LiveStream(() => {
    calls++
    throw new Error("no route")
  }, clock.timers)
  stream.subscribe({})
  await clock.advance(RECONNECT_MS[0])
  assert.equal(calls, 2)
})

// ---- serialize --------------------------------------------------------------------

test("serialize never overlaps and collapses a burst into one rerun", async () => {
  let active = 0
  let maxActive = 0
  let runs = 0
  const gates: (() => void)[] = []
  const fn = serialize(async () => {
    active++
    maxActive = Math.max(maxActive, active)
    runs++
    await new Promise<void>((r) => gates.push(r))
    active--
    return runs
  })
  const a = fn()
  const b = fn()
  const c = fn()
  assert.equal(b, c)
  gates.shift()!()
  assert.equal(await a, 1)
  await flush()
  gates.shift()!()
  assert.equal(await b, 2)
  assert.equal(runs, 2)
  assert.equal(maxActive, 1)
})

test("serialize keeps going after a failure", async () => {
  let n = 0
  const fn = serialize(async () => {
    n++
    if (n === 1) throw new Error("x")
    return n
  })
  const a = fn()
  const b = fn()
  await assert.rejects(a)
  assert.equal(await b, 2)
})

// ---- startLiveRefresh ---------------------------------------------------------------

function refresher(changes: boolean[] = []) {
  let calls = 0
  return {
    calls: () => calls,
    refresh: async () => {
      calls++
      return changes.shift() ?? false
    },
  }
}

test("no stream: polls 4s → 10s → 30s while nothing changes, resets on change", async () => {
  const clock = fakeClock()
  const r = refresher([false, false, false, true, false])
  startLiveRefresh({ stream: null, refresh: r.refresh, fallbackMs: [4000, 10000, 30000], liveMs: 60000, timers: clock.timers })
  await clock.advance(4000)
  assert.equal(r.calls(), 1)
  await clock.advance(10000)
  assert.equal(r.calls(), 2)
  await clock.advance(30000)
  assert.equal(r.calls(), 3)
  await clock.advance(30000) // this one reports a change
  assert.equal(r.calls(), 4)
  await clock.advance(4000) // back to the first step
  assert.equal(r.calls(), 5)
})

test("live: events drive the screen, the poll drops to the slow safety beat", async () => {
  const { stream, sockets, clock } = streamWith()
  const r = refresher()
  const seen: string[] = []
  startLiveRefresh({ stream, refresh: r.refresh, fallbackMs: [4000, 10000, 30000], liveMs: 60000, timers: clock.timers, onEvent: (e) => seen.push(e.type) })
  sockets[0].frame({ type: "hello" })
  await flush()
  assert.equal(r.calls(), 1) // one catch-up on turning live
  sockets[0].frame({ type: "list-changed" })
  assert.deepEqual(seen, ["list-changed"])
  await clock.advance(59000)
  sockets[0].frame({ type: "ping" })
  assert.equal(r.calls(), 1)
  await clock.advance(1000)
  assert.equal(r.calls(), 2) // safety refresh
})

test("stream drops: polling resumes at the first fallback step", async () => {
  const { stream, sockets, clock } = streamWith()
  const r = refresher()
  startLiveRefresh({ stream, refresh: r.refresh, fallbackMs: [4000, 10000, 30000], liveMs: 60000, timers: clock.timers })
  sockets[0].frame({ type: "hello" })
  await flush()
  const base = r.calls()
  sockets[0].drop()
  await clock.advance(4000)
  assert.equal(r.calls(), base + 1)
})

test("stop() ends polling and releases the stream", async () => {
  const { stream, sockets, clock } = streamWith()
  const r = refresher()
  const seen: string[] = []
  const stop = startLiveRefresh({ stream, refresh: r.refresh, fallbackMs: [4000], liveMs: 60000, timers: clock.timers, onEvent: (e) => seen.push(e.type) })
  stop()
  sockets[0].frame({ type: "hello" })
  sockets[0].frame({ type: "list-changed" })
  await clock.advance(LINGER_MS + 100000)
  assert.equal(r.calls(), 0)
  assert.deepEqual(seen, [])
  assert.equal(sockets[0].closed, true)
})

test("a stream already live when a screen subscribes skips the fallback beat", async () => {
  const { stream, sockets, clock } = streamWith()
  stream.subscribe({})
  sockets[0].frame({ type: "hello" })
  const r = refresher()
  startLiveRefresh({ stream, refresh: r.refresh, fallbackMs: [1500], liveMs: 15000, timers: clock.timers })
  await clock.advance(14999)
  assert.equal(r.calls(), 0)
  await clock.advance(1)
  assert.equal(r.calls(), 1)
})
