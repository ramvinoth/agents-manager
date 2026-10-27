/**
 * Test double for the far end of the Harman relay: a fake WebSocket whose
 * peer speaks viewer/relay.py's end-to-end protocol. Shared by the transport
 * tests; not a test file itself (npm test runs *.test.ts only).
 */
import assert from "node:assert/strict"
import nacl from "tweetnacl"
import { concatBytes, fromBase64, toBase64, utf8Decode, utf8Encode } from "./bytes.ts"
import { HTTP_BODY, HTTP_END, HTTP_REQ, RES_BODY, RES_END, RES_HEAD, pack, unpack } from "./relayChannel.ts"
import type { WireSocket } from "./relayTransport.ts"

export const serverKeys = nacl.box.keyPair.fromSecretKey(Uint8Array.from({ length: 32 }, (_, i) => i))
export const route = { url: "https://relay.example", serverId: "abcdefghijklmnop1234", publicKey: toBase64(serverKeys.publicKey) }

function nonce(dir: number, c: number) {
  const n = new Uint8Array(24)
  n[0] = dir
  new DataView(n.buffer).setUint32(20, c)
  return n
}

export type Frame = { kind: number; stream: number; payload: Uint8Array }

/** The server end of one phone socket, speaking viewer/relay.py's protocol. */
export class FakeServer {
  key: Uint8Array | null = null
  rx = 0
  tx = 0
  frames: Frame[] = []
  hellos = 0
  readonly sock: FakeSocket
  constructor(sock: FakeSocket) {
    this.sock = sock
  }
  onFrame: (f: Frame) => void = () => {}
  fromPhone(data: string | ArrayBuffer) {
    if (typeof data === "string") {
      const msg = JSON.parse(data)
      assert.equal(msg.type, "e2ee_hello")
      this.hellos++
      if (this.sock.answerHello) {
        this.key = nacl.box.before(fromBase64(msg.key), serverKeys.secretKey)
        this.sock.deliver('{"type":"e2ee_ready"}')
      }
      return
    }
    const b = new Uint8Array(data)
    assert.deepEqual(b.subarray(0, 24), nonce(0, this.rx++), "phone nonces count up from 0")
    const plain = nacl.box.open.after(b.subarray(24), b.subarray(0, 24), this.key!)
    assert.ok(plain, "phone frame authenticates")
    const f = unpack(plain)
    this.frames.push(f)
    this.onFrame(f)
  }
  send(kind: number, stream: number, payload?: Uint8Array | string) {
    const p = typeof payload === "string" ? utf8Encode(payload) : payload
    const n = nonce(1, this.tx++)
    const box = nacl.box.after(pack(kind, stream, p), n, this.key!)
    this.sock.deliver(concatBytes([n, box]).buffer as ArrayBuffer)
  }
  /** Answer HTTP like the loopback server would. */
  http(handler: (req: any, body: Uint8Array) => { status: number; headers?: Record<string, string>; body?: string | Uint8Array }) {
    const pending = new Map<number, { req: any; body: Uint8Array[] }>()
    this.onFrame = (f) => {
      if (f.kind === HTTP_REQ) pending.set(f.stream, { req: JSON.parse(utf8Decode(f.payload)), body: [] })
      else if (f.kind === HTTP_BODY) pending.get(f.stream)!.body.push(f.payload)
      else if (f.kind === HTTP_END) {
        const p = pending.get(f.stream)!
        const res = handler(p.req, concatBytes(p.body))
        this.send(RES_HEAD, f.stream, JSON.stringify({ status: res.status, headers: res.headers || {} }))
        if (res.body !== undefined) this.send(RES_BODY, f.stream, res.body)
        this.send(RES_END, f.stream)
      }
    }
    this.replay()
  }
  /** Feed frames that arrived before the handler was installed through it. */
  replay() {
    for (const f of this.frames) this.onFrame(f)
  }
}

export const sockets: FakeSocket[] = []
/** Whether newly dialed fake servers answer the hello. */
export const hello = { answer: true }
export class FakeSocket implements WireSocket {
  binaryType = "blob"
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  answerHello = hello.answer
  server = new FakeServer(this)
  readonly url: string
  constructor(url: string) {
    this.url = url
    sockets.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.({})
    })
  }
  send(data: string | ArrayBuffer) {
    if (this.readyState !== 1) throw new Error("send on closed socket")
    this.server.fromPhone(data)
  }
  deliver(data: string | ArrayBuffer) {
    queueMicrotask(() => this.readyState === 1 && this.onmessage?.({ data }))
  }
  close(code = 1000) {
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => this.onclose?.({ code }))
  }
}

let seed = 0
export const deps = {
  WebSocket: FakeSocket,
  randomBytes: (n: number) => Uint8Array.from({ length: n }, () => (seed = (seed * 31 + 7) & 0xff)),
  helloEveryMs: 5,
  handshakeMs: 200,
}
export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
export const last = () => sockets[sockets.length - 1]
