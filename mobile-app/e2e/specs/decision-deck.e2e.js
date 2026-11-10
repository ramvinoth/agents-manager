const assert = require("node:assert/strict")
const { startFixture, SESSION, BOARD_SESSION_B } = require("../thread-board-fixture")
const { signIn } = require("../signin")

const shown = id => $("~" + id).isDisplayed()
async function tap(id) { const el = await $("~" + id); await el.waitForDisplayed(); await el.click() }

// A touch drag on an element: sideways by a fraction of the screen width
// and/or vertically by dyPx, starting clear of the iOS back-swipe edge.
async function drag(id, dxFrac, dyPx = 0, ms = 300) {
  const el = await $("~" + id); await el.waitForDisplayed()
  const { y } = await el.getLocation(), { height } = await el.getSize()
  const { width: W } = await browser.getWindowSize()
  const y0 = Math.round(y + height / 2), x0 = Math.round(W * (dxFrac > 0 ? .2 : dxFrac < 0 ? .8 : .5))
  await browser.performActions([{ type: "pointer", id: "d", parameters: { pointerType: "touch" }, actions: [
    { type: "pointerMove", duration: 0, x: x0, y: y0 }, { type: "pointerDown", button: 0 },
    { type: "pointerMove", duration: ms, x: Math.round(x0 + W * dxFrac), y: y0 + dyPx }, { type: "pointerUp", button: 0 },
  ] }])
  await browser.releaseActions()
  await browser.pause(800)
}

// The decision deck: open decisions open by themselves on launch as a stack of
// cards — swipe right approves, left denies, a pull past the card's edge pages,
// round Deny / Comment / Approve buttons do the same by tap.
describe("Decision deck — swipe to decide", function () {
  this.timeout(300000)
  let fixture
  const writes = r => fixture.deckWrites.filter(x => x.route === r)
  const count = async () => (await $("~cockpit-count").getText()).trim()

  before(async () => {
    assert.equal(process.env.E2E_BUNDLE_ID, "com.suhai.agents.e2e", "Never run against a production bundle")
    fixture = await startFixture({ deck: true })
    await signIn(fixture)
  })
  after(async () => {
    try { assert.deepEqual(fixture?.forbidden, []) } finally { await fixture?.close() }
  })

  it("opens by itself on launch with every open decision", async () => {
    await $("~decision-cockpit").waitForDisplayed({ timeout: 20000 })
    assert.match(await count(), /^4 open/)
    await $("~cockpit-approval").waitForDisplayed()
    for (const id of ["deck-deny", "deck-comment", "deck-approve"]) assert.ok(await shown(id), `${id} shown`)
    assert.ok(!(await shown("cockpit-error")))
  })

  it("a comment on a tool approval goes to the agent and leaves it open", async () => {
    await tap("deck-comment")
    await $("~deck-comment-input").setValue("Why npm test?")
    await tap("deck-comment-send")
    await $("~deck-notice").waitForDisplayed()
    const sent = writes("POST /api/inbox/send")
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0].body, { to: `session:${SESSION}`, body: "Why npm test?" })
    assert.match(await count(), /^4 open/)
    assert.ok(await shown("cockpit-approval"), "still on the same decision")
  })

  it("pages with the arrows and by pulling past the card's edge", async () => {
    await tap("cockpit-next")
    await $("~plan-card").waitForDisplayed()
    await tap("cockpit-prev")
    await $("~cockpit-approval").waitForDisplayed()
    await drag("deck-card", 0, -300) // push up past the bottom → next
    await $("~plan-card").waitForDisplayed()
    await drag("deck-card", 0, 300) // pull down past the top → previous
    await $("~cockpit-approval").waitForDisplayed()
    assert.equal(fixture.deckWrites.length, 1, "paging decides nothing")
  })

  it("swipe right allows the tool and moves to the next decision", async () => {
    await drag("deck-card", 0.6)
    await browser.waitUntil(() => writes("POST /api/chat/permission/decide").length === 1, { timeout: 10000 })
    assert.deepEqual(writes("POST /api/chat/permission/decide")[0].body, { session: SESSION, id: "perm-1", decision: "allow" })
    await $("~plan-card").waitForDisplayed()
    assert.match(await count(), /^3 open/)
  })

  it("swipe left denies the plan", async () => {
    await drag("deck-card", -0.6)
    await browser.waitUntil(() => writes("POST /api/chat/plan/decide").length === 1, { timeout: 10000 })
    assert.deepEqual(writes("POST /api/chat/plan/decide")[0].body, { session: BOARD_SESSION_B, decision: "deny" })
    await $("~cockpit-red").waitForDisplayed()
    assert.match(await count(), /^2 open/)
  })

  it("an org approval asks once more before it runs", async () => {
    await tap("deck-approve")
    await $("~deck-red-confirm").waitForDisplayed()
    assert.equal(writes("POST /api/org/approvals/resolve").length, 0, "nothing runs before the confirm")
    await tap("deck-red-cancel")
    assert.ok(!(await shown("deck-red-confirm")))
    await tap("deck-approve")
    await tap("deck-red-confirm-approve")
    await browser.waitUntil(() => writes("POST /api/org/approvals/resolve").length === 1, { timeout: 10000 })
    assert.deepEqual(writes("POST /api/org/approvals/resolve")[0].body, { id: 7, resolution: "approved" })
    await $("~cockpit-card").waitForDisplayed()
    assert.match(await count(), /^1 open/)
  })

  it("approving a card moves it to Approved and the deck closes when empty", async () => {
    await tap("deck-approve")
    await browser.waitUntil(() => writes("POST /api/org/cards/move").length === 1, { timeout: 10000 })
    assert.deepEqual(writes("POST /api/org/cards/move")[0].body, { card_id: 201, column_id: 104, position: 9999 })
    await $("~decision-cockpit").waitForDisplayed({ reverse: true, timeout: 10000 })
    await $("~chats-list").waitForDisplayed()
  })
})
