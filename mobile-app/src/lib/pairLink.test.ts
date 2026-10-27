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
const SID = "Q2xhdWRlLXNlcnZlci1pZA"
const PK = Buffer.alloc(32, 7).toString("base64")
const relayQ = (url = "wss://relay.example.com", sid = SID, pk = PK) =>
  `relay=${encodeURIComponent(url)}&sid=${encodeURIComponent(sid)}&pk=${encodeURIComponent(pk)}`

test("parses the link the web builds", () => {
  const link = `agents://pair?code=${CODE}&url=${encodeURIComponent("https://agents.suhai.ai/")}`
  assert.deepEqual(parsePairLink(link), { url: "https://agents.suhai.ai", code: CODE })
})

test("keeps a port and a path prefix", () => {
  const link = `agents://pair?url=${encodeURIComponent("http://100.64.0.2:8091/h")}&code=${CODE}`
  assert.deepEqual(parsePairLink(` ${link} `), { url: "http://100.64.0.2:8091/h", code: CODE })
})

test("a relay-only link and a link with both routes", () => {
  const relay = { url: "wss://relay.example.com", serverId: SID, publicKey: PK }
  assert.deepEqual(parsePairLink(`agents://pair?code=${CODE}&${relayQ()}`), { code: CODE, relay })
  assert.deepEqual(parsePairLink(`agents://pair?code=${CODE}&url=https%3A%2F%2Fx&${relayQ("wss://relay.example.com/")}`),
    { code: CODE, url: "https://x", relay })
})

test("rejects a malformed relay rather than dropping it", () => {
  const bad = [
    relayQ("ws://relay.example.com"),           // no TLS
    relayQ(undefined, "short"),                // id the relay refuses
    relayQ(undefined, SID, Buffer.alloc(31).toString("base64")),
    relayQ(undefined, SID, "not base64!"),
    `sid=${SID}&pk=${encodeURIComponent(PK)}`, // partial
  ]
  for (const q of bad) assert.equal(parsePairLink(`agents://pair?code=${CODE}&url=https%3A%2F%2Fx&${q}`), null, q)
})

test("rejects plain server URLs and other schemes", () => {
  assert.equal(parsePairLink("https://agents.suhai.ai"), null)
  assert.equal(parsePairLink(`evil://pair?url=https%3A%2F%2Fx&code=${CODE}`), null)
  assert.equal(parsePairLink(""), null)
})

test("rejects a non-http server, no route, a missing or short code, bad escapes", () => {
  assert.equal(parsePairLink(`agents://pair?url=${encodeURIComponent("javascript:alert(1)")}&code=${CODE}`), null)
  assert.equal(parsePairLink(`agents://pair?code=${CODE}`), null)
  assert.equal(parsePairLink(`agents://pair?url=${encodeURIComponent("https://x")}`), null)
  assert.equal(parsePairLink(`agents://pair?url=${encodeURIComponent("https://x")}&code=short`), null)
  assert.equal(parsePairLink(`agents://pair?url=%E0%A4%A&code=${CODE}`), null)
})

console.log(`${passed} passing`)
