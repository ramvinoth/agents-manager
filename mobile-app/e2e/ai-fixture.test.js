const assert = require("node:assert/strict")
const test = require("node:test")
const { startFixture, SESSION, NEW_SESSION, PROVIDER, LONG_MODEL } = require("./thread-board-fixture")

test("AI fixture reflects capabilities, save errors/revisions and isolated atomic creation", async () => {
  const fixture = await startFixture({ ai: true, port: 0 })
  const get = async path => (await fetch(fixture.url + path)).json()
  const post = (path, body) => fetch(fixture.url + path, { method: "POST", body: JSON.stringify(body) })
  try {
    const builtIn = await get("/api/ai/defaults?host=local&agent=claude")
    assert.deepEqual(builtIn.capabilities.conversationModes, ["agent"])
    const custom = await get(`/api/ai/defaults?provider=${PROVIDER}&convMode=chat`)
    assert.deepEqual(custom.capabilities.efforts, [""])
    assert.deepEqual(custom.capabilities.conversationModes, ["agent", "chat"])
    assert.equal((await get("/api/ai/defaults?host=remote&agent=claude")).capabilities.customProviders, false)
    const selection = { provider: PROVIDER, model: { kind: "id", id: LONG_MODEL }, convMode: "agent", effort: "" }
    const save = { revision: 0, selection, host: "local", agent: "claude" }
    fixture.state.failNextSave = true
    assert.equal((await post("/api/ai/defaults", save)).status, 503)
    assert.equal(fixture.state.defaults.revision, 0)
    assert.equal((await post("/api/ai/defaults", save)).status, 200)
    assert.equal((await post("/api/ai/defaults", save)).status, 409)
    assert.equal(fixture.state.sessions[SESSION].selection.model, null)
    assert.equal((await post("/api/session/ai", { ...save, id: SESSION, title: "Forbidden unrelated update" })).status, 400)
    assert.equal((await post("/api/new-session", { message: "hello", ai: selection, host: "local", agent: "claude" })).status, 200)
    assert.equal(fixture.state.sessions[NEW_SESSION].revision, 1)
    const resolved = await get(`/api/resolve?id=${NEW_SESSION}`)
    assert.equal(resolved.found, true)
    assert.equal(resolved.path, `/fixture/${NEW_SESSION}.jsonl`)
    assert.equal((await post("/api/session-meta", { provider: PROVIDER })).status, 403)
    assert.equal((await post("/api/chat", { message: "no execution" })).status, 403)
    assert.deepEqual(fixture.forbidden, ["POST /api/session-meta", "POST /api/chat"])
  } finally { await fixture.close() }
})

test("AI fixture offers long discovery and failure without transport/proxy fallback", async () => {
  const fixture = await startFixture({ ai: true, port: 0 })
  const get = async id => (await fetch(`${fixture.url}/api/providers/models?id=${id}`)).json()
  try {
    assert.equal((await get("")).status, "unsupported")
    assert.equal((await get("fixture-error")).status, "error")
    const result = await get(PROVIDER)
    assert.equal(result.models.length, 140)
    assert(result.choices.some(row => row.id === LONG_MODEL))
    fixture.state.discoveryFailure = false
    assert.equal((await get("fixture-error")).status, "ok")
  } finally { await fixture.close() }
})
