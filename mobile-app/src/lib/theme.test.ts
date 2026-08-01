import assert from "node:assert"
import { contrast, DARK, effectiveScheme, LIGHT, themeFor } from "./theme.ts"

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

test("themeFor picks the right palette", () => {
  assert.equal(themeFor("dark"), DARK)
  assert.equal(themeFor("light"), LIGHT)
  assert.equal(themeFor(null), LIGHT, "no preference falls back to light")
})

// The real bug this guards: text that is technically 'dark theme' but unreadable.
for (const [label, t] of [
  ["light", LIGHT],
  ["dark", DARK],
] as const) {
  test(`${label}: body text on every surface meets WCAG AA (4.5:1)`, () => {
    for (const surface of [t.bg, t.surface, t.bubbleAgent, t.bubbleUser, t.inputBg, t.chipBg]) {
      const ratio = contrast(t.text, surface)
      assert.ok(ratio >= 4.5, `text ${t.text} on ${surface} = ${ratio.toFixed(2)}:1`)
    }
  })

  test(`${label}: code text on the code surface meets WCAG AA (4.5:1)`, () => {
    const ratio = contrast(t.codeText, t.codeBg)
    assert.ok(ratio >= 4.5, `codeText ${t.codeText} on ${t.codeBg} = ${ratio.toFixed(2)}:1`)
  })

  test(`${label}: muted text stays legible (3:1)`, () => {
    for (const surface of [t.bg, t.surface, t.bubbleAgent]) {
      const ratio = contrast(t.textMuted, surface)
      assert.ok(ratio >= 3, `muted ${t.textMuted} on ${surface} = ${ratio.toFixed(2)}:1`)
    }
  })

  test(`${label}: danger colour is distinguishable on its surface`, () => {
    assert.ok(contrast(t.danger, t.surface) >= 3)
  })

  test(`${label}: text on the danger-tinted surface meets WCAG AA (4.5:1)`, () => {
    // Error tool chips/results render body text on dangerBg — the exact bug
    // that made errored tools unreadable in dark mode.
    const ratio = contrast(t.text, t.dangerBg)
    assert.ok(ratio >= 4.5, `text ${t.text} on dangerBg ${t.dangerBg} = ${ratio.toFixed(2)}:1`)
  })
}

test("contrast maths: black on white is the 21:1 maximum", () => {
  assert.equal(Math.round(contrast("#000000", "#ffffff")), 21)
  assert.equal(Math.round(contrast("#ffffff", "#ffffff")), 1)
})

test("effectiveScheme: a forced pref overrides the OS", () => {
  assert.equal(effectiveScheme("light", "dark"), "light")
  assert.equal(effectiveScheme("dark", "light"), "dark")
})

test("effectiveScheme: 'system' follows the OS, defaulting to light", () => {
  assert.equal(effectiveScheme("system", "dark"), "dark")
  assert.equal(effectiveScheme("system", "light"), "light")
  assert.equal(effectiveScheme("system", null), "light", "no OS pref → light")
  assert.equal(effectiveScheme("system", undefined), "light")
})

console.log(`${passed} passing`)
