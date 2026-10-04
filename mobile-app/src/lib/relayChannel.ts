/**
 * The phone side of the Harman relay's end-to-end channel — the mirror of
 * viewer/relay.py's Channel, pack and unpack. Pure (no sockets, no state
 * outside the object) so it is node-tested against vectors the server made.
 *
 * Handshake: the phone repeats a plaintext {"type":"e2ee_hello","key":<its
 * ephemeral X25519 public key>} until the server answers {"type":"e2ee_ready"}.
 * After that every frame is binary [nonce24][NaCl box], keyed by the phone's
 * ephemeral secret and the server's static public key from the pairing QR —
 * so the relay, which only routes, can neither read nor forge a frame.
 *
 * Nonce = direction byte (0 phone->server, 1 server->phone) + 15 zero bytes
 * + a u64 big-endian counter. Each side counts its own frames from 0 and the
 * key is fresh per connection, so a (key, nonce) pair never repeats; a
 * replayed, reordered or dropped frame fails the counter check and is fatal.
 *
 * Inside one encrypted frame: [type u8][stream u32 big-endian][payload].
 */
import nacl from "tweetnacl"
import { fromBase64, toBase64 } from "./bytes.ts"

export const HTTP_REQ = 0x01
export const HTTP_BODY = 0x02
export const HTTP_END = 0x03
export const RES_HEAD = 0x11
export const RES_BODY = 0x12
export const RES_END = 0x13
export const ERROR = 0x14
export const WS_OPEN = 0x21
export const WS_OPENED = 0x22
export const WS_TEXT = 0x23
export const WS_BINARY = 0x24
export const WS_CLOSE = 0x25
export const CANCEL = 0x30

/** Body chunk size; matches the server's CHUNK. */
export const CHUNK = 256 * 1024

const TO_SERVER = 0
const TO_PHONE = 1

export class ChannelError extends Error {}

function nonce(direction: number, counter: number): Uint8Array {
  const n = new Uint8Array(24)
  n[0] = direction
  // counter < 2^53 always (one frame per byte would take years); write the
  // u64 as two u32 halves.
  const view = new DataView(n.buffer)
  view.setUint32(16, Math.floor(counter / 0x100000000))
  view.setUint32(20, counter >>> 0)
  return n
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

export class RelayChannel {
  readonly publicKey: Uint8Array
  private readonly key: Uint8Array
  private tx = 0
  private rx = 0
  ready = false

  /** `secretKey` is 32 fresh random bytes per connection (expo-crypto's
   *  getRandomBytes in the app; fixed in tests). */
  constructor(serverPublicKey: string, secretKey: Uint8Array) {
    const serverPk = fromBase64(serverPublicKey)
    if (serverPk.length !== 32 || secretKey.length !== 32) throw new ChannelError("bad key length")
    this.publicKey = nacl.box.keyPair.fromSecretKey(secretKey).publicKey
    this.key = nacl.box.before(serverPk, secretKey)
  }

  hello(): string {
    return JSON.stringify({ type: "e2ee_hello", key: toBase64(this.publicKey) })
  }

  /** Handle a plaintext text frame; true once the server has said ready. */
  acceptText(text: string): boolean {
    try {
      if (JSON.parse(text)?.type === "e2ee_ready") this.ready = true
    } catch {
      // not ours; ignore
    }
    return this.ready
  }

  seal(plaintext: Uint8Array): Uint8Array {
    if (!this.ready) throw new ChannelError("channel not ready")
    const n = nonce(TO_SERVER, this.tx++)
    const box = nacl.box.after(plaintext, n, this.key)
    const out = new Uint8Array(24 + box.length)
    out.set(n)
    out.set(box, 24)
    return out
  }

  open(frame: Uint8Array): Uint8Array {
    if (!this.ready) throw new ChannelError("encrypted frame before handshake")
    if (frame.length < 24 + 16 || !sameBytes(frame.subarray(0, 24), nonce(TO_PHONE, this.rx))) {
      throw new ChannelError("unexpected nonce (replayed, reordered or dropped frame)")
    }
    const plain = nacl.box.open.after(frame.subarray(24), frame.subarray(0, 24), this.key)
    if (!plain) throw new ChannelError("frame failed authentication")
    this.rx++
    return plain
  }
}

export function pack(kind: number, stream: number, payload?: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + (payload?.length ?? 0))
  out[0] = kind
  new DataView(out.buffer).setUint32(1, stream)
  if (payload) out.set(payload, 5)
  return out
}

export function unpack(frame: Uint8Array): { kind: number; stream: number; payload: Uint8Array } {
  if (frame.length < 5) throw new ChannelError("short mux frame")
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  return { kind: frame[0], stream: view.getUint32(1), payload: frame.subarray(5) }
}
