/**
 * Guard against the palette debt regrowing: every colour in screens/,
 * components/ and lib/ must come from a Theme token. The only files allowed to
 * spell a hex literal are the palette itself, identity tints that are
 * deliberately scheme-independent (avatar seeds, template categories), the
 * WebView HTML shells whose CSS cannot read a JS token, and the terminal,
 * pairing camera and full-screen image viewer, which are fixed dark surfaces by design.
 */
import assert from "node:assert"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

// Run from mobile-app/ like every other lib test (see package.json "test").
const ROOT = "src"
const ALLOWED = new Set([
  "lib/theme.ts",
  "lib/theme.test.ts",
  "lib/avatars.ts",
  "lib/templateCategories.ts",
  "components/MermaidView.tsx",
  "components/MathView.tsx",
  "screens/TerminalScreen.tsx",
  "components/PairScanner.tsx",
  "components/ImageViewer.tsx",
])
// Shadow black and translucent scrims are colour-neutral, not palette choices.
const NEUTRAL = /shadowColor: "#000"|rgba\(0,0,0,/
// A colour is a 6/8-digit hex anywhere, or 3/4-digit shorthand given to a colour
// prop, e.g. color set to a quoted #333. Elsewhere "#107" is the board's card-number syntax.
const HEX = /#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b|(?:[cC]olou?r|[bB]ackground|[bB]order|[tT]int)\w*\s*[:=]\s*\{?\s*["'`]#[0-9a-fA-F]{3,4}["'`]/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

const offenders: string[] = []
for (const sub of ["screens", "components", "lib"]) {
  for (const file of walk(join(ROOT, sub))) {
    const rel = file.slice(ROOT.length + 1)
    if (ALLOWED.has(rel)) continue
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (HEX.test(line) && !NEUTRAL.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
    })
  }
}

try {
  assert.deepEqual(offenders, [], "hex colour literals outside the palette:\n  " + offenders.join("\n  "))
  console.log("themeLiterals: 1 passed")
} catch (e) {
  console.error(`✖ ${(e as Error).message}`)
  process.exitCode = 1
}
