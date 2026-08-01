import assert from "node:assert"
import {
  addToList,
  activeEntry,
  migrateLegacy,
  normalizeUrl,
  parseState,
  removeFromList,
  setActiveToken,
  switchInList,
  EMPTY_STATE,
  type ServerState,
} from "./servers.ts"

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

test("normalizeUrl trims and drops trailing slashes", () => {
  assert.equal(normalizeUrl("  https://x:8091/  "), "https://x:8091")
  assert.equal(normalizeUrl("https://x///"), "https://x")
})

test("addToList appends without switching", () => {
  const { state, entry } = addToList(EMPTY_STATE, "https://a")
  assert.equal(state.servers.length, 1)
  assert.equal(entry.url, "https://a")
  assert.equal(entry.token, "", "new entry has no token yet")
  assert.equal(state.activeId, "", "adding does not change the active server")
})

test("addToList dedupes by normalized url, keeping the token", () => {
  let s: ServerState = EMPTY_STATE
  s = addToList(s, "https://a").state
  s = setActiveTokenFor(s, "https://a", "tok1")
  const { state, entry } = addToList(s, "https://a/") // trailing slash → same server
  assert.equal(state.servers.length, 1, "no duplicate created")
  assert.equal(entry.token, "tok1", "existing token preserved")
})

test("addToList updates nickname on an existing entry", () => {
  let s = addToList(EMPTY_STATE, "https://a").state
  const { state } = addToList(s, "https://a", "Home")
  assert.equal(state.servers[0].name, "Home")
})

test("addToList stores optional nickname, blank → undefined", () => {
  assert.equal(addToList(EMPTY_STATE, "https://a", "  ").entry.name, undefined)
  assert.equal(addToList(EMPTY_STATE, "https://a", " Cloud ").entry.name, "Cloud")
})

test("switchInList sets active; ignores unknown id", () => {
  const { state, entry } = addToList(EMPTY_STATE, "https://a")
  assert.equal(switchInList(state, entry.id).activeId, entry.id)
  assert.equal(switchInList(state, "nope").activeId, "", "unknown id is a no-op")
})

test("setActiveToken writes only onto the active entry", () => {
  let s = EMPTY_STATE
  const a = addToList(s, "https://a")
  s = a.state
  const b = addToList(s, "https://b")
  s = b.state
  s = switchInList(s, a.entry.id)
  s = setActiveToken(s, "tokA")
  assert.equal(s.servers.find((x) => x.id === a.entry.id)!.token, "tokA")
  assert.equal(s.servers.find((x) => x.id === b.entry.id)!.token, "", "other server untouched")
})

test("removeFromList: removing active falls back to first remaining", () => {
  let s = EMPTY_STATE
  const a = addToList(s, "https://a"); s = a.state
  const b = addToList(s, "https://b"); s = b.state
  s = switchInList(s, a.entry.id)
  s = removeFromList(s, a.entry.id)
  assert.equal(s.servers.length, 1)
  assert.equal(s.activeId, b.entry.id, "active fell back to the remaining server")
})

test("removeFromList: removing the last leaves empty active", () => {
  const a = addToList(EMPTY_STATE, "https://a")
  const s = removeFromList(switchInList(a.state, a.entry.id), a.entry.id)
  assert.deepEqual(s, { servers: [], activeId: "" })
})

test("removeFromList: removing a non-active keeps active", () => {
  let s = EMPTY_STATE
  const a = addToList(s, "https://a"); s = a.state
  const b = addToList(s, "https://b"); s = b.state
  s = switchInList(s, a.entry.id)
  s = removeFromList(s, b.entry.id)
  assert.equal(s.activeId, a.entry.id)
})

test("migrateLegacy seeds one active entry from scalar url+token", () => {
  const s = migrateLegacy("https://old/", "legacyTok")
  assert.equal(s.servers.length, 1)
  assert.equal(s.servers[0].url, "https://old", "url normalized")
  assert.equal(s.servers[0].token, "legacyTok")
  assert.equal(s.activeId, s.servers[0].id, "the migrated server is active")
})

test("migrateLegacy with no url → empty state", () => {
  assert.deepEqual(migrateLegacy("", "ignored"), EMPTY_STATE)
})

test("parseState round-trips a valid state and rejects junk", () => {
  const a = addToList(EMPTY_STATE, "https://a")
  const round = parseState(JSON.stringify(a.state))
  assert.deepEqual(round, a.state)
  assert.equal(parseState(null), null)
  assert.equal(parseState("{not json"), null)
  assert.equal(parseState('{"servers":"x"}'), null, "servers must be an array")
})

test("parseState drops malformed entries", () => {
  const raw = JSON.stringify({ servers: [{ id: "1", url: "https://a", token: "" }, { bad: true }], activeId: "1" })
  const s = parseState(raw)!
  assert.equal(s.servers.length, 1)
})

test("activeEntry resolves the active server", () => {
  const a = addToList(EMPTY_STATE, "https://a")
  const s = switchInList(a.state, a.entry.id)
  assert.equal(activeEntry(s)!.url, "https://a")
  assert.equal(activeEntry(EMPTY_STATE), undefined)
})

// Helper: set a token on a specific url's entry (test convenience).
function setActiveTokenFor(state: ServerState, url: string, token: string): ServerState {
  const id = state.servers.find((s) => s.url === normalizeUrl(url))!.id
  return setActiveToken(switchInList(state, id), token)
}

console.log(`${passed} passing`)
