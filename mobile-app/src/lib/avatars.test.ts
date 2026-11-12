// Unit tests for the avatar helpers. Pure functions — no react-native imports —
// so they run under `node --experimental-strip-types`.
import assert from "node:assert"
import { AVATARS, AGENT_HUES, agentNameColor, hashString, avatarColor, avatarGlyph } from "./avatars.ts"
import { LIGHT, DARK, contrast } from "./theme.ts"

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

test("every agent name colour clears WCAG AA on its bubble", () => {
  for (const h of AGENT_HUES) {
    assert.ok(contrast(h.text.light, LIGHT.bubbleAgent) >= 4.5, `light ${h.text.light}`)
    assert.ok(contrast(h.text.light, LIGHT.bubbleUser) >= 4.5, `light/user ${h.text.light}`)
    assert.ok(contrast(h.text.dark, DARK.bubbleAgent) >= 4.5, `dark ${h.text.dark}`)
    assert.ok(contrast(h.text.dark, DARK.bubbleUser) >= 4.5, `dark/user ${h.text.dark}`)
  }
})

test("an agent has one colour: name and avatar share a hue, stable per id", () => {
  assert.equal(agentNameColor("sid-1", "dark"), agentNameColor("sid-1", "dark"))
  const hue = AGENT_HUES.find((h) => h.fill === avatarColor("sid-1"))
  assert.equal(hue?.text.light, agentNameColor("sid-1", "light"))
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
