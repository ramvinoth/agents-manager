import assert from "node:assert"
import { matchCommands, slashTerm } from "./slash.ts"

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

const CMDS = [
  { name: "review" },
  { name: "loop" },
  { name: "init" },
  { name: "security-review" },
  { name: "telegram:access" },
]

test("slashTerm only triggers on a lone leading slash", () => {
  assert.equal(slashTerm("/rev"), "rev")
  assert.equal(slashTerm("/"), "")
  assert.equal(slashTerm("hello /rev"), null, "mid-sentence slash is not a command")
  assert.equal(slashTerm("/loop 5m go"), null, "already has args — stop suggesting")
})

test("prefix matches rank above substring matches", () => {
  const m = matchCommands("review", CMDS)
  assert.equal(m[0].name, "review", "prefix match first")
  assert.equal(m[1].name, "security-review", "substring match second")
})

test("empty term lists everything (capped)", () => {
  assert.equal(matchCommands("", CMDS).length, 5)
  assert.equal(matchCommands("", CMDS, 2).length, 2)
})

test("null term yields nothing", () => {
  assert.deepEqual(matchCommands(null, CMDS), [])
})

test("matches namespaced commands", () => {
  assert.equal(matchCommands("telegram", CMDS)[0].name, "telegram:access")
})

test("no match yields empty", () => {
  assert.deepEqual(matchCommands("zzz", CMDS), [])
})

console.log(`${passed} passing`)
