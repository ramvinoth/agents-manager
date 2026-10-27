import assert from "node:assert"
import { randomBytes } from "node:crypto"
import { concatBytes, fromBase64, toArrayBuffer, toBase64, utf8Decode, utf8Encode } from "./bytes.ts"

let passed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
  } catch (e) {
    console.error(`✖ ${name}\n  ${(e as Error).message}`)
    process.exitCode = 1
  }
}

test("base64 matches node for every length 0..300 and a big buffer", () => {
  for (let n = 0; n <= 300; n++) {
    const b = new Uint8Array(randomBytes(n))
    const want = Buffer.from(b).toString("base64")
    assert.equal(toBase64(b), want)
    assert.deepEqual(fromBase64(want), b)
  }
  const big = new Uint8Array(randomBytes(3 * 1024 * 1024 + 1))
  assert.equal(toBase64(big), Buffer.from(big).toString("base64"))
  assert.deepEqual(fromBase64(Buffer.from(big).toString("base64")), big)
})

test("base64 accepts url-safe, no padding, whitespace; rejects junk", () => {
  const b = new Uint8Array([251, 255, 191])
  assert.deepEqual(fromBase64("-_-_"), fromBase64("+/+/"))
  assert.deepEqual(fromBase64("+/+/\n"), new Uint8Array([251, 255, 191]))
  assert.deepEqual(fromBase64("QQ"), new Uint8Array([65]))
  assert.deepEqual(fromBase64(toBase64(b)), b)
  assert.throws(() => fromBase64("ab*d"))
  assert.throws(() => fromBase64("abcde"))
})

test("utf8 round-trips and matches node, including astral and edge cases", () => {
  for (const s of ["", "hello", "é", "€uro", "👋 agents ✓", "中文テキスト", "a\u0000b"]) {
    assert.deepEqual(utf8Encode(s), new Uint8Array(Buffer.from(s, "utf8")))
    assert.equal(utf8Decode(new Uint8Array(Buffer.from(s, "utf8"))), s)
  }
  const long = "x€👋".repeat(20000)
  assert.equal(utf8Decode(utf8Encode(long)), long)
})

test("utf8 decode replaces malformed input like TextDecoder", () => {
  const td = new TextDecoder()
  for (const bad of [[0xff], [0xc0, 0x80], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0x61, 0xf0, 0x9f, 0x61], [0xf4, 0x90, 0x80, 0x80], [0xe0, 0x80, 0x80], [0xe2, 0x82, 0xac, 0xe2], [0xf0, 0x9f, 0x91]]) {
    assert.equal(utf8Decode(Uint8Array.from(bad)), td.decode(Uint8Array.from(bad)), JSON.stringify(bad))
  }
})

test("concat and exact ArrayBuffer", () => {
  const all = concatBytes([Uint8Array.from([1, 2]), new Uint8Array(0), Uint8Array.from([3])])
  assert.deepEqual(all, Uint8Array.from([1, 2, 3]))
  const view = all.subarray(1, 2)
  assert.equal(toArrayBuffer(view).byteLength, 1)
  assert.equal(toArrayBuffer(all), all.buffer)
})

console.log(`${passed} passing`)
