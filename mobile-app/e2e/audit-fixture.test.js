const assert = require("node:assert/strict")
const test = require("node:test")
const { startFixture } = require("./thread-board-fixture")
const { SENTINELS } = require("./audit-fixture-data")
const path = "/api/org/audit?view=display-v1&limit=50&result=all"

test("audit fixture pages and filters safe DTOs, rejects all unexpected writes", async () => {
  const fixture = await startFixture({ audit: true, port: 0 })
  try {
    const first = await (await fetch(fixture.url + path)).json()
    assert.deepEqual(first.audit.map(row => row.id), [309, 308, 307])
    assert.equal(first.next_before, 307)
    const second = await (await fetch(fixture.url + path + "&before=307")).json()
    assert.deepEqual(second.audit.map(row => row.id), [306, 305, 304])
    const third = await (await fetch(fixture.url + path + "&before=304")).json()
    assert.deepEqual(third.audit.map(row => row.id), [303, 302, 301])
    assert.equal(third.next_before, null)
    const queued = await (await fetch(fixture.url + path.replace("result=all", "result=queued"))).json()
    assert.deepEqual(queued.audit.map(row => row.id), [308, 303])
    assert.equal(queued.next_before, null)
    for (const sentinel of SENTINELS) assert(!JSON.stringify(fixture.audit.responses).includes(sentinel))
    assert.equal((await fetch(fixture.url + "/api/org/audit")).status, 400)
    for (const route of ["/api/org/card/move", "/api/chat", "/api/ai/defaults", "/api/new-session", "/api/org/approvals"]) {
      assert.equal((await fetch(fixture.url + route, { method: "POST", body: "{}" })).status, 403)
    }
    assert.equal(fixture.forbidden.length, 5)
  } finally { await fixture.close() }
})

test("audit fixture failures are one-shot and card failures contain redaction sentinels", async () => {
  const fixture = await startFixture({ audit: true, port: 0 })
  try {
    fixture.audit.failNext = 503
    const failure = await fetch(fixture.url + path)
    assert.equal(failure.status, 503)
    assert((await failure.json()).error.includes(SENTINELS[0]))
    assert.equal((await fetch(fixture.url + path)).status, 200)
    fixture.audit.failNext = "network"
    await assert.rejects(fetch(fixture.url + path))
    assert.equal((await fetch(fixture.url + path)).status, 200)
    fixture.audit.cardStatus = 403
    assert.equal((await fetch(fixture.url + "/api/org/card?id=201")).status, 403)
    fixture.audit.cardStatus = "null"
    assert.equal((await (await fetch(fixture.url + "/api/org/card?id=201")).json()).card, null)
  } finally { await fixture.close() }
})

test("default board fixture remains read-only and does not expose audit scenario", async () => {
  const fixture = await startFixture({ port: 0 })
  try {
    assert.equal(fixture.audit, undefined)
    assert.equal((await fetch(fixture.url + path)).status, 404)
    const card = await (await fetch(fixture.url + "/api/org/card?id=201")).json()
    assert.equal(card.card.id, 201)
    assert.equal((await fetch(fixture.url + "/api/new-session", { method: "POST", body: "{}" })).status, 403)
  } finally { await fixture.close() }
})
