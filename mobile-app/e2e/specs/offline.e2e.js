const assert = require("node:assert/strict")
const { startFixture, SESSION } = require("../thread-board-fixture")

const shown = id => $("~" + id).isDisplayed()
async function tap(id) { const el = await $("~" + id); await el.waitForDisplayed(); await el.click() }
const BUNDLE = process.env.E2E_BUNDLE_ID

// Offline: when the server stops answering, the app shows a calm "can't reach
// the server" strip over its last saved copy of the chats and the thread —
// never a red error in place of them — and recovers by itself when the server
// is back. The fixture is stopped and restarted on the SAME port to simulate it.
describe("Offline — saved chats + reachability banner", function () {
  this.timeout(240000)
  let fixture
  const port = Number(process.env.E2E_FIXTURE_PORT || 18769)

  before(async () => {
    assert.equal(BUNDLE, "com.suhai.agents.e2e", "Never run against a production bundle")
    fixture = await startFixture({ port })
    await browser.waitUntil(async () => await shown("server-url") || await shown("login-username") || await shown("chats-list"), { timeout: 30000 })
    if (await shown("server-url")) {
      await $("~server-url").setValue(fixture.url); await tap("server-connect")
      await browser.waitUntil(async () => await shown("login-username") || await shown("chats-list"))
    }
    if (await shown("login-username")) {
      await $("~login-username").setValue("fixture"); await $("~login-password").setValue("fixture"); await tap("login-submit")
    }
    await $(`~chat-${SESSION}`).waitForDisplayed()
    // Open the thread once online so its transcript is saved on the device.
    await tap(`chat-${SESSION}`)
    await $("~thread-list").waitForDisplayed()
    await browser.pause(2000) // let the first read land and be saved
    await driver.back()
    await $("~chats-list").waitForDisplayed()
    assert.ok(!(await shown("offline-banner")), "no banner while online")
  })
  after(async () => { await fixture?.close() })

  it("server gone while running: banner appears, the list stays", async () => {
    await fixture.close()
    await $("~offline-banner").waitForDisplayed({ timeout: 15000 }) // the 4s chats poll notices
    assert.ok(await shown(`chat-${SESSION}`), "saved list still on screen")
  })

  // Not a cold relaunch: after terminateApp the unsigned e2e build comes back on
  // "Connect server" (its keychain login doesn't survive), so that path can't be
  // driven here. Opening the chat remounts the thread, whose live read fails.
  it("offline, opening a chat shows its saved transcript", async () => {
    await tap(`chat-${SESSION}`)
    await $("~thread-list").waitForDisplayed()
    await $("~offline-banner").waitForDisplayed({ timeout: 15000 })
    const empty = await $('-ios predicate string:label CONTAINS "isn\'t saved on this phone"').isExisting()
    assert.ok(!empty, "the saved transcript renders, not the empty-offline hint")
  })

  it("server back: banner clears on its own", async () => {
    fixture = await startFixture({ port })
    await driver.back()
    await $("~chats-list").waitForDisplayed()
    await browser.waitUntil(async () => !(await shown("offline-banner")), { timeout: 20000, timeoutMsg: "banner never cleared" })
    assert.ok(await shown(`chat-${SESSION}`))
  })
})
