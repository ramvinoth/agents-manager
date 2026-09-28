/**
 * Guard against the palette debt regrowing: every colour in screens/,
 * components/ and lib/ must come from a Theme token. The only files allowed to
 * spell a hex literal are the palette itself, identity tints that are
 * deliberately scheme-independent (avatar seeds, template categories), the
 * WebView HTML shells whose CSS cannot read a JS token, and the terminal,
 * which is a fixed dark surface by design.
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
  "lib/builtinTemplates.ts",
  "components/MermaidView.tsx",
  "components/MathView.tsx",
  "screens/TerminalScreen.tsx",
])
// Shadow black and translucent scrims are colour-neutral, not palette choices.
const NEUTRAL = /shadowColor: "#000"|rgba\(0,0,0,/

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
      if (/#[0-9a-fA-F]{3,8}\b/.test(line) && !NEUTRAL.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
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
