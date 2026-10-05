const assert = require("node:assert/strict")
const { startFixture, SESSION, BOARD_SESSION_B } = require("../thread-board-fixture")

const shown = id => $("~" + id).isDisplayed()
async function tap(id) { const el = await $("~" + id); await el.waitForDisplayed(); await el.click() }

// The Inbox reads like a messenger: a conversation list (needs-you first), a
// bubble thread per chat, decisions as bubbles with their two actions, and a
// composer — against a stateful local fixture that records every write.
describe("Native inbox — conversations, bubbles, decisions, composer", function () {
  this.timeout(240000)
  let fixture
  const writes = r => fixture.requests.filter(x => x.route === r)

  before(async () => {
    assert.equal(process.env.E2E_BUNDLE_ID, "com.suhai.agents.e2e", "Never run against a production bundle")
    fixture = await startFixture({ inbox: true })
    await browser.waitUntil(async () => await shown("server-url") || await shown("login-username") || await shown("chats-list"), { timeout: 30000 })
    if (await shown("server-url")) {
      await $("~server-url").setValue(fixture.url); await tap("server-connect")
      await browser.waitUntil(async () => await shown("login-username") || await shown("chats-list"))
    }
    if (await shown("login-username")) {
      await $("~login-username").setValue("fixture"); await $("~login-password").setValue("fixture"); await tap("login-submit")
    }
    await $("~chats-list").waitForDisplayed()
    await tap("tab-Inbox")
    await $("~inbox-list").waitForDisplayed()
  })
  after(async () => { await fixture?.close() })

  it("lists one row per chat, the one waiting on you first", async () => {
    await $(`~inbox-conv-${SESSION}`).waitForDisplayed()
    await $(`~inbox-conv-${BOARD_SESSION_B}`).waitForDisplayed()
    // The row is one accessible element (VoiceOver reads it whole), so the
    // pill is checked through the row's label rather than its own testID.
    const label = await $(`~inbox-conv-${SESSION}`).getAttribute("label")
    assert.match(label, /needs you/, "open question marks its chat")
    const yA = (await $(`~inbox-conv-${SESSION}`).getLocation()).y
    const yB = (await $(`~inbox-conv-${BOARD_SESSION_B}`).getLocation()).y
    assert.ok(yA < yB, `needs-you chat sorts first (${yA} < ${yB}) even though B is newer`)
    assert.ok(!(await shown("inbox-error")))
  })

  it("Needs you narrows to the waiting chat", async () => {
    await tap("inbox-filter-needs")
    await browser.pause(300)
    assert.ok(await shown(`inbox-conv-${SESSION}`))
    assert.ok(!(await shown(`inbox-conv-${BOARD_SESSION_B}`)))
    await tap("inbox-filter-all")
    await $(`~inbox-conv-${BOARD_SESSION_B}`).waitForDisplayed()
  })

  it("opening a chat marks its free message read, not its decision", async () => {
    await tap(`inbox-conv-${BOARD_SESSION_B}`)
    await $("~inbox-thread").waitForDisplayed()
    await $("~inbox-msg-3").waitForDisplayed()
    await browser.waitUntil(async () => writes("POST /api/inbox/read").length === 1, { timeout: 10000 })
    assert.deepEqual(writes("POST /api/inbox/read")[0].body, { id: 3 })
    await tap("inbox-composer")
    await $("~inbox-composer").setValue("Thanks — looks good")
    await tap("inbox-send")
    await browser.waitUntil(async () => writes("POST /api/inbox/send").length === 1, { timeout: 10000 })
    const sent = writes("POST /api/inbox/send")[0].body
    assert.equal(sent.to, `session:${BOARD_SESSION_B}`)
    assert.equal(sent.body, "Thanks — looks good")
    assert.equal(sent.in_reply_to, 3)
    await $("~inbox-msg-103").waitForDisplayed()
    await driver.back()
    await $("~inbox-list").waitForDisplayed()
  })

  it("a decision bubble snoozes with Later and keeps its open action", async () => {
    await tap(`inbox-conv-${SESSION}`)
    await $("~inbox-msg-2").waitForDisplayed()
    assert.ok(await shown("inbox-decide-2"))
    await tap("inbox-snooze-2")
    await tap("snooze-1")
    await browser.waitUntil(async () => writes("POST /api/inbox/snooze").length === 1, { timeout: 10000 })
    assert.deepEqual(writes("POST /api/inbox/snooze")[0].body, { id: 2, hours: 1 })
    await browser.waitUntil(async () => !(await shown("inbox-snooze-2")), { timeout: 10000 })
    assert.ok(await shown("inbox-decide-2"), "snoozed is deferred, not decided")
    assert.equal(writes("POST /api/inbox/read").length, 1, "the decision was never marked read")
    await driver.back()
  })

  it("+ picks a chat to message", async () => {
    await $("~inbox-list").waitForDisplayed()
    await tap("inbox-compose")
    await tap(`inbox-to-${SESSION}`)
    await $("~inbox-thread").waitForDisplayed()
    await $("~inbox-composer").waitForDisplayed()
    await driver.back()
    await $("~inbox-list").waitForDisplayed()
  })
})
