import assert from "node:assert/strict"
import { fromBase64, toBase64, utf8Encode } from "./bytes.ts"
import { RelayChannel, pack, unpack, HTTP_REQ, RES_END, ChannelError } from "./relayChannel.ts"

// Vectors produced by viewer/relay.py (server sk = bytes 0..31, phone sk = bytes 32..63).
const SPK = "j0DFrbaPJWJK5bIU6nZ6bslNgp09e14a0bpvPiE4KF8="
const PPK = "NYBy1jZYgNGu6jKa35EhODhR7SGijjt16WXQ0s0WYlQ="
const TO_PHONE = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3bmkfTVanNCNxm073+Nod2oNo/dT"
const TO_SERVER = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARlDBRzyExURe2DYi6joB675jnwZ2jJK1FRBvj49pNspDuLIVCg=="

const phoneSk = () => Uint8Array.from({ length: 32 }, (_, i) => 32 + i)
const ready = () => {
  const ch = new RelayChannel(SPK, phoneSk())
  ch.acceptText('{"type":"e2ee_ready"}')
  return ch
}

let n = 0
function test(name: string, fn: () => void) {
  fn()
  n++
}

test("hello carries the phone's public key", () => {
  const ch = new RelayChannel(SPK, phoneSk())
  assert.deepEqual(JSON.parse(ch.hello()), { type: "e2ee_hello", key: PPK })
  assert.equal(ch.acceptText("not json"), false)
  assert.equal(ch.acceptText('{"type":"other"}'), false)
  assert.equal(ch.acceptText('{"type":"e2ee_ready"}'), true)
})

test("seal matches the server's expected frame byte for byte", () => {
  const frame = ready().seal(pack(HTTP_REQ, 1, utf8Encode('{"method":"GET"}')))
  assert.equal(toBase64(frame), TO_SERVER)
})

test("opens a server frame and unpacks it", () => {
  const { kind, stream, payload } = unpack(ready().open(fromBase64(TO_PHONE)))
  assert.equal(kind, RES_END)
  assert.equal(stream, 7)
  assert.equal(payload.length, 0)
})

test("replay, tamper and pre-handshake frames are rejected", () => {
  const ch = ready()
  ch.open(fromBase64(TO_PHONE))
  assert.throws(() => ch.open(fromBase64(TO_PHONE)), ChannelError) // counter moved on
  const bad = fromBase64(TO_PHONE)
  bad[bad.length - 1] ^= 1
  assert.throws(() => ready().open(bad), ChannelError)
  const fresh = new RelayChannel(SPK, phoneSk())
  assert.throws(() => fresh.open(fromBase64(TO_PHONE)), ChannelError)
  assert.throws(() => fresh.seal(new Uint8Array(1)), ChannelError)
})

test("pack/unpack round-trip large stream ids", () => {
  const f = unpack(pack(0x24, 0xfffffffe, Uint8Array.of(1, 2, 3)))
  assert.deepEqual([f.kind, f.stream, [...f.payload]], [0x24, 0xfffffffe, [1, 2, 3]])
  assert.throws(() => unpack(Uint8Array.of(1, 2)), ChannelError)
})

console.log(`relayChannel: ${n} passed`)
