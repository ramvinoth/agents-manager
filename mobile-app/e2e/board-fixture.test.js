const assert = require("node:assert/strict")
const { test } = require("node:test")
const { startFixture, SESSION } = require("./thread-board-fixture")
const B = "native-board-fixture-b"

async function request(fixture, path, body) {
  const response = await fetch(fixture.url + path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

test("board mutations are explicit opt-in and never persist across fixtures", async () => {
  await assert.rejects(startFixture({ boardMutations: true, port: 0 }), /isolated board/)
  const fixture = await startFixture({ boardIsolation: true, port: 0 })
  try {
    for (const path of ["/api/org/cards", "/api/org/cards/move"]) {
      assert.equal((await request(fixture, path, { title: "No writes" })).status, 403)
    }
    assert.deepEqual(fixture.forbidden, ["POST /api/org/cards", "POST /api/org/cards/move"])
    assert.equal((await request(fixture, "/api/org/card?id=202")).body.card.column_id, 101)
  } finally { await fixture.close() }
})

test("human inline create and agent move return persisted detail columns without changing other sessions", async () => {
  const fixture = await startFixture({ boardIsolation: true, boardMutations: true, port: 0 })
  try {
    const title = "Long human request\n\n" + "Please verify every requirement before changing the board. ".repeat(35)
    const created = await request(fixture, "/api/org/cards", { title, column_id: 101, session: SESSION })
    assert.equal(created.status, 200)
    assert.equal(created.body.title, title.trim())
    assert.equal(created.body.body, "", "Inline create has no body editor")
    assert.equal(created.body.project_id, 1)
    assert.equal(created.body.session_id, SESSION)
    assert.equal(created.body.created_by, "user:fixture")
    const projectCard = await request(fixture, "/api/org/cards", { title: "Project card", column_id: 101, project_id: 1 })
    assert.equal(projectCard.status, 200)
    assert.equal(projectCard.body.session_id, null)
    for (const id of [created.body.id, 202]) {
      const before = await request(fixture, `/api/org/card?id=${id}`)
      assert.deepEqual(before.body.columns.map(c => c.id), [101, 102, 103])
      const moved = await request(fixture, "/api/org/cards/move", { card_id: id, column_id: 102, position: 9999 })
      assert.equal(moved.status, 200)
      const reopened = await request(fixture, `/api/org/card?id=${id}`)
      assert.equal(reopened.body.card.column_id, 102)
      assert.deepEqual(reopened.body.columns, before.body.columns)
    }
    const b = await request(fixture, `/api/org/cards?session=${B}`)
    assert.deepEqual(b.body.cards.map(c => c.id), [211, 212])
    assert(b.body.cards.every(c => c.column_id === 101))
    assert.deepEqual(fixture.forbidden, [])
  } finally { await fixture.close() }
  const fresh = await startFixture({ boardIsolation: true, boardMutations: true, port: 0 })
  try {
    assert.equal((await request(fresh, "/api/org/card?id=202")).body.card.column_id, 101)
    assert.equal((await request(fresh, `/api/org/cards?session=${SESSION}`)).body.cards.length, 2)
  } finally { await fresh.close() }
})

test("opt-in board writes strictly reject unknown scopes, fields, columns, cards and unsupported operations", async () => {
  const fixture = await startFixture({ boardIsolation: true, boardMutations: true, port: 0 })
  try {
    const valid = { title: "Human task", column_id: 101, session: SESSION }
    for (const patch of [{ title: " " }, { session: "unknown" }, { session: undefined }, { project_id: 2 }, { column_id: 999 }, { created_by: "agent" }, { body: "Not an inline field" }]) {
      assert.equal((await request(fixture, "/api/org/cards", { ...valid, ...patch })).status, 400)
    }
    for (const body of [null, [], { card_id: 999, column_id: 102, position: 1 }, { card_id: 202, column_id: 999, position: 1 }, { card_id: 202, column_id: 102, position: "1" }, { card_id: 202, column_id: 102, position: 1, extra: true }]) {
      assert.equal((await request(fixture, "/api/org/cards/move", body)).status, 400)
    }
    assert.equal((await request(fixture, "/api/org/cards?project=1", valid)).status, 400)
    assert.equal((await request(fixture, "/api/org/cards/delete", { card_id: 202 })).status, 403)
    assert.equal((await request(fixture, "/api/org/card?id=999")).status, 404)
    assert.equal((await request(fixture, `/api/org/cards?session=${SESSION}`)).body.cards.length, 2)
    assert.equal((await request(fixture, "/api/org/card?id=202")).body.card.column_id, 101)
  } finally { await fixture.close() }
})

test("opt-in board fixture distinguishes same-project sessions and rejects missing scope", async () => {
  const fixture = await startFixture({ boardIsolation: true, port: 0 })
  try {
    const get = async path => { const response = await fetch(fixture.url + path); return { status: response.status, body: await response.json() } }
    const sessions = await get("/api/sessions")
    assert.deepEqual(sessions.body.map(s => s.id), [SESSION, B])
    const a = await get(`/api/org/cards?session=${SESSION}`)
    const b = await get(`/api/org/cards?session=${B}`)
    assert.deepEqual(a.body.cards.map(c => c.id), [201, 202])
    assert.deepEqual(b.body.cards.map(c => c.id), [211, 212])
    assert(b.body.cards.every(c => c.session_id === B && c.project_id === 1))
    assert.deepEqual((await get(`/api/org/board?session=${SESSION}`)).body, (await get(`/api/org/board?session=${B}`)).body)
    assert.equal((await get("/api/org/cards")).status, 400)
    assert.equal((await get("/api/org/cards?session=")).status, 400)
    assert.equal((await get("/api/org/board?session=unknown")).status, 400)
    assert.equal((await get("/api/org/cards?project=1")).body.cards.length, 4)
    assert.equal((await get(`/api/org/cards?project=1&session=${B}&assignee=9`)).body.cards.length, 0)
    assert.equal((await get("/api/org/card?id=211")).body.card.session_id, B)
  } finally { await fixture.close() }
})

test("board response holds and failures are deterministic and fixture-local", async () => {
  const fixture = await startFixture({ boardIsolation: true, port: 0 })
  try {
    const gate = fixture.board.holdNext("cards", SESSION)
    const pending = fetch(`${fixture.url}/api/org/cards?session=${SESSION}`)
    await gate.requested
    const b = await fetch(`${fixture.url}/api/org/cards?session=${B}`)
    assert.equal((await b.json()).cards[0].id, 211)
    gate.release(503)
    assert.equal((await pending).status, 503)
    assert.equal((await fetch(`${fixture.url}/api/org/cards?session=${SESSION}`)).status, 200)
    assert.deepEqual(fixture.forbidden, [])
  } finally { await fixture.close() }
})
