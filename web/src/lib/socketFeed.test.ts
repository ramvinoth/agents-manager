import { SocketFeed, backoffMs, socketUrl, type FeedSocket, type FeedTimers } from "./socketFeed.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

class FakeSocket implements FeedSocket {
  onopen: (() => void) | null = null
  onmessage: ((m: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  closed = false
  send(d: string) { this.sent.push(d) }
  close() { this.closed = true }
}

class FakeTimers implements FeedTimers {
  now = 0
  private next = 1
  pending = new Map<number, { at: number; fn: () => void; ms: number }>()
  setTimeout(fn: () => void, ms: number) { const id = this.next++; this.pending.set(id, { at: this.now + ms, fn, ms }); return id }
  clearTimeout(h: unknown) { this.pending.delete(h as number) }
  advance(ms: number) {
    const end = this.now + ms
    for (;;) {
      const due = [...this.pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.pending.delete(due[0])
      this.now = due[1].at
      due[1].fn()
    }
    this.now = end
  }
  delays() { return [...this.pending.values()].map((t) => t.ms) }
}

function setup(staleMs = 0) {
  const socks: FakeSocket[] = []
  const timers = new FakeTimers()
  const feed = new SocketFeed(() => { const s = new FakeSocket(); socks.push(s); return s }, staleMs, timers)
  return { socks, timers, feed }
}

eq("backoff starts at 1s", backoffMs(0), 1000)
eq("backoff doubles", backoffMs(3), 8000)
eq("backoff caps at 30s", backoffMs(20), 30000)
eq("socket url follows the page's scheme", socketUrl("/api/x", { protocol: "https:", host: "h:1" }), "wss://h:1/api/x")
eq("plain http gives ws", socketUrl("/api/x", { protocol: "http:", host: "h" }), "ws://h/api/x")

{
  const { socks, feed } = setup()
  const log: string[] = []
  const off = feed.subscribe({ onOpen: (r) => log.push("open:" + r), onMessage: (m) => log.push("msg:" + m), onClose: () => log.push("close") })
  feed.subscribe({})
  eq("one socket for every listener", socks.length, 1)
  eq("send before open is refused", feed.send("x"), false)
  socks[0].onopen!()
  eq("first open is not a reconnect", log, ["open:false"])
  eq("send once open", [feed.send("hi"), socks[0].sent], [true, ["hi"]])
  socks[0].onmessage!({ data: "frame" })
  eq("messages reach listeners", log.at(-1), "msg:frame")
  off()
  eq("socket stays while a listener remains", socks[0].closed, false)
}

{
  const { socks, timers, feed } = setup()
  const log: string[] = []
  const off = feed.subscribe({ onOpen: (r) => log.push("open:" + r), onClose: () => log.push("close") })
  socks[0].onopen!()
  socks[0].onclose!()
  eq("a drop tells listeners and schedules a retry", [log, timers.delays()], [["open:false", "close"], [1000]])
  timers.advance(1000)
  eq("retry opens a new socket", socks.length, 2)
  socks[1].onclose!()                              // failed before opening: no close event
  eq("a failed attempt backs off further, silently", [log.length, timers.delays()], [2, [2000]])
  timers.advance(2000)
  socks[2].onopen!()
  eq("open after drops is a reconnect", log.at(-1), "open:true")
  socks[0].onclose!()                              // an old socket's late close
  eq("a replaced socket's close is ignored", [feed.open, timers.delays()], [true, []])
  off()
  eq("last listener closes the socket and cancels retries", [socks[2].closed, feed.open, timers.delays()], [true, false, []])
  feed.subscribe({ onOpen: (r) => log.push("again:" + r) })
  socks[3].onopen!()
  eq("a fresh subscription after shutdown is not a reconnect", log.at(-1), "again:false")
}

{
  const { socks, timers, feed } = setup(60000)
  const log: string[] = []
  feed.subscribe({ onClose: () => log.push("close") })
  socks[0].onopen!()
  timers.advance(59000)
  socks[0].onmessage!({ data: "ping" })
  timers.advance(59000)
  eq("frames keep a quiet socket alive", [socks[0].closed, log], [false, []])
  timers.advance(1000)
  eq("silence past staleMs closes it as dropped", [socks[0].closed, log, feed.open], [true, ["close"], false])
  timers.advance(1000)
  eq("and it reconnects", socks.length, 2)
}

{
  const timers = new FakeTimers()
  let n = 0
  const feed = new SocketFeed(() => { n++; throw new Error("no WebSocket") }, 0, timers)
  feed.subscribe({})
  eq("a throwing opener is retried with backoff", [n, timers.delays()], [1, [1000]])
}

console.log(`socketFeed: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
