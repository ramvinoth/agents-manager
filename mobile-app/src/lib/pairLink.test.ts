import assert from "node:assert"
import { parsePairLink } from "./pairLink.ts"

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

const CODE = "abcdEFGH1234_-xyzABC"

test("parses the link the web builds", () => {
  const link = `agents://pair?url=${encodeURIComponent("https://agents.suhai.ai/")}&code=${CODE}`
  assert.deepEqual(parsePairLink(link), { url: "https://agents.suhai.ai", code: CODE })
})

test("keeps a port and a path prefix", () => {
  const link = `agents://pair?code=${CODE}&url=${encodeURIComponent("http://100.64.0.2:8091/h")}`
  assert.deepEqual(parsePairLink(` ${link} `), { url: "http://100.64.0.2:8091/h", code: CODE })
})

test("rejects plain server URLs and other schemes", () => {
  assert.equal(parsePairLink("https://agents.suhai.ai"), null)
  assert.equal(parsePairLink(`evil://pair?url=https%3A%2F%2Fx&code=${CODE}`), null)
  assert.equal(parsePairLink(""), null)
})

test("rejects a non-http server, a missing or short code, bad escapes", () => {
  assert.equal(parsePairLink(`agents://pair?url=${encodeURIComponent("javascript:alert(1)")}&code=${CODE}`), null)
  assert.equal(parsePairLink(`agents://pair?url=${encodeURIComponent("https://x")}`), null)
  assert.equal(parsePairLink(`agents://pair?url=${encodeURIComponent("https://x")}&code=short`), null)
  assert.equal(parsePairLink(`agents://pair?url=%E0%A4%A&code=${CODE}`), null)
})

console.log(`${passed} passing`)
