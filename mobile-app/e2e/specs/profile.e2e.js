const assert = require("node:assert/strict")
const { startFixture } = require("../thread-board-fixture")
const shown = id => $("~" + id).isDisplayed()

async function tap(id) { await reveal(id); await $("~" + id).click() }
// Bounded native swipes until the control is on screen (the Profile scrolls).
async function reveal(id) {
  for (let n = 0; n < 8; n++) {
    const { width, height } = await browser.getWindowSize()
    const el = await $("~" + id)
    // isDisplayed is true even under the bottom tab bar, where a tap hits the bar:
    // require the control in the upper 70% of the screen.
    if (await el.isDisplayed() && (await el.getLocation()).y < height * .7) return
    const x = Math.round(width * .5)
    await browser.performActions([{ type: "pointer", id: "p", parameters: { pointerType: "touch" }, actions: [
      { type: "pointerMove", duration: 0, x, y: Math.round(height * .6) }, { type: "pointerDown", button: 0 },
      { type: "pointerMove", duration: 500, x, y: Math.round(height * .3) }, { type: "pointerUp", button: 0 },
    ] }])
    await browser.releaseActions()
  }
  assert.fail(`Cannot reveal ${id}`)
}
const label = async id => (await $("~" + id)).getAttribute("label")

describe("Profile — honest identity and the two schedule switches", function () {
  this.timeout(180000)
  let fixture
  before(async () => {
    assert.equal(process.env.E2E_BUNDLE_ID, "com.suhai.agents.e2e", "Never run against a production bundle")
    fixture = await startFixture({})
    await browser.waitUntil(async () => await shown("server-url") || await shown("login-username") || await shown("chats-list"), { timeout: 30000 })
    if (await shown("server-url")) {
      await $("~server-url").setValue(fixture.url); await $("~server-connect").click()
      await browser.waitUntil(async () => await shown("login-username") || await shown("chats-list"))
    }
    if (await shown("login-username")) {
      await $("~login-username").setValue("fixture"); await $("~login-password").setValue("fixture"); await $("~login-submit").click()
    }
    await $("~chats-list").waitForDisplayed()
  })
  after(async () => { await fixture?.close() })

  it("shows the server role, groups by reach, and flips schedules with one POST each", async () => {
    await $("~tab-Profile").click()
    await $("~profile-role").waitForDisplayed()
    assert.equal(await label("profile-role"), "Owner of this server")
    await reveal("server-scope-hint")
    assert.match(await label("profile-autonomy-summary"), /Nothing runs on a schedule/)

    await tap("schedules-mine")
    await browser.waitUntil(async () => /only your schedules/.test(await label("profile-autonomy-summary")), { timeoutMsg: "summary must follow the switch" })
    const posts = () => fixture.requests.filter(r => r.route === "POST /api/org/loop-control").map(r => r.body.mode)
    assert.deepEqual(posts(), ["user"])

    await tap("schedules-agents")
    await browser.waitUntil(async () => posts().length === 2, { timeoutMsg: "the agents switch must POST" })
    assert.deepEqual(posts(), ["user", "both"])
    // The fixture's automation switch is OFF, so agent schedules are licensed but
    // still cannot fire — the summary must not claim they run.
    await browser.pause(400)
    assert.match(await label("profile-autonomy-summary"), /only your schedules/)
  })
})
