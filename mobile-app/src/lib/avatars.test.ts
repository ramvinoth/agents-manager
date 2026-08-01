// Unit tests for the avatar helpers. Pure functions — no react-native imports —
// so they run under `node --experimental-strip-types`.
import assert from "node:assert"
import { AVATARS, hashString, avatarColor, avatarGlyph } from "./avatars.ts"

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

test("there are exactly 20 avatars", () => {
  assert.equal(AVATARS.length, 20)
})

test("hashString is stable and non-negative", () => {
  assert.equal(hashString("abc"), hashString("abc"))
  assert.ok(hashString("anything") >= 0)
  assert.notEqual(hashString("a"), hashString("b"))
})

test("avatarColor is deterministic for a seed", () => {
  assert.equal(avatarColor("sid-1"), avatarColor("sid-1"))
  assert.ok(avatarColor("sid-1").startsWith("#"))
})

test("avatarGlyph returns the chosen avatar when set", () => {
  assert.equal(avatarGlyph("🦊", "sid-1"), "🦊")
  assert.equal(avatarGlyph("  🚀  ", "sid-1"), "🚀") // trimmed
})

test("avatarGlyph falls back to a stable default emoji when unset", () => {
  const a = avatarGlyph("", "sid-xyz")
  const b = avatarGlyph(undefined, "sid-xyz")
  assert.equal(a, b) // same seed -> same default
  assert.ok(AVATARS.includes(a as (typeof AVATARS)[number]))
})

console.log(`${passed} passing`)
