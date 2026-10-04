/**
 * Byte helpers shared by everything that moves binary data: base64 (the only
 * encoding expo-file-system reads/writes binary in) and UTF-8 (Hermes ships
 * TextEncoder but no TextDecoder, so both directions are done here, once).
 *
 * Table-based, never String.fromCharCode.apply(null, big) — that blows the
 * call stack on the multi-MB buffers this carries (voice replies, downloads).
 */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i
  t["-".charCodeAt(0)] = 62 // accept base64url too
  t["_".charCodeAt(0)] = 63
  return t
})()

export function toBase64(data: Uint8Array | ArrayBuffer): string {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data)
  const parts: string[] = []
  let out = ""
  for (let i = 0; i < b.length; i += 3) {
    const b0 = b[i]
    const b1 = i + 1 < b.length ? b[i + 1] : -1
    const b2 = i + 2 < b.length ? b[i + 2] : -1
    out += B64[b0 >> 2]
    out += B64[((b0 & 0x03) << 4) | (b1 < 0 ? 0 : b1 >> 4)]
    out += b1 < 0 ? "=" : B64[((b1 & 0x0f) << 2) | (b2 < 0 ? 0 : b2 >> 6)]
    out += b2 < 0 ? "=" : B64[b2 & 0x3f]
    if (out.length >= 8192) {
      parts.push(out)
      out = ""
    }
  }
  parts.push(out)
  return parts.join("")
}

/** Decode base64 (standard or url-safe, padding optional, whitespace ignored).
 *  Throws on any other character rather than silently dropping it. */
export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[\s=]+/g, "")
  if (clean.length % 4 === 1) throw new Error("invalid base64 length")
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let acc = 0
  let bits = 0
  let o = 0
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i)
    const v = c < 128 ? B64_INDEX[c] : -1
    if (v < 0) throw new Error("invalid base64 character")
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out
}

export function utf8Encode(s: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
        i++
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd // lone surrogate
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return Uint8Array.from(out)
}

/** Decode UTF-8 exactly like TextDecoder (WHATWG: each maximal invalid
 *  subpart becomes one U+FFFD), which Hermes does not provide. */
export function utf8Decode(b: Uint8Array): string {
  const parts: string[] = []
  let units: number[] = []
  const push = (cp: number) => {
    if (cp >= 0x10000) {
      cp -= 0x10000
      units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
    } else units.push(cp)
    if (units.length >= 4096) {
      parts.push(String.fromCharCode(...units))
      units = []
    }
  }
  let cp = 0
  let need = 0
  let seen = 0
  let lo = 0x80
  let hi = 0xbf
  for (let i = 0; i < b.length; i++) {
    const c = b[i]
    if (need === 0) {
      if (c < 0x80) push(c)
      else if (c >= 0xc2 && c <= 0xdf) (need = 1), (cp = c & 0x1f)
      else if (c >= 0xe0 && c <= 0xef) {
        if (c === 0xe0) lo = 0xa0
        if (c === 0xed) hi = 0x9f
        ;(need = 2), (cp = c & 0xf)
      } else if (c >= 0xf0 && c <= 0xf4) {
        if (c === 0xf0) lo = 0x90
        if (c === 0xf4) hi = 0x8f
        ;(need = 3), (cp = c & 0x7)
      } else push(0xfffd)
      continue
    }
    if (c < lo || c > hi) {
      // invalid continuation: emit one U+FFFD and reprocess this byte
      ;(cp = need = seen = 0), (lo = 0x80), (hi = 0xbf)
      push(0xfffd)
      i--
      continue
    }
    ;(lo = 0x80), (hi = 0xbf)
    cp = (cp << 6) | (c & 0x3f)
    if (++seen === need) {
      push(cp)
      cp = need = seen = 0
    }
  }
  if (need) push(0xfffd)
  if (units.length) parts.push(String.fromCharCode(...units))
  return parts.join("")
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let n = 0
  for (const c of chunks) n += c.length
  const out = new Uint8Array(n)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

/** An exact ArrayBuffer for `b` (a view's .buffer may be larger and shared). */
export function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength
    ? (b.buffer as ArrayBuffer)
    : (b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
}
