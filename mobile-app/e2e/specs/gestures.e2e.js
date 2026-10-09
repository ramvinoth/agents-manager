const assert = require("node:assert/strict")
const { startFixture, SESSION } = require("../thread-board-fixture")
const shown = id => $("~" + id).isDisplayed()
async function tap(id) { const el = await $("~" + id); await el.waitForDisplayed(); await el.click() }
// A finger drag across the chat row, the way a thumb does it (300ms).
async function drag(id, dxFrac, ms = 300, dyPx = 0, x0Frac) {
  const el = await $("~" + id); await el.waitForDisplayed()
  const { x, y } = await el.getLocation(), { width, height } = await el.getSize()
  const { width: W } = await browser.getWindowSize()
  const y0 = Math.round(y + height / 2), x0 = Math.round(W * (x0Frac ?? (dxFrac > 0 ? .2 : .8)))
  await browser.performActions([{ type: "pointer", id: "g", parameters: { pointerType: "touch" }, actions: [
    { type: "pointerMove", duration: 0, x: x0, y: y0 }, { type: "pointerDown", button: 0 },
    { type: "pointerMove", duration: ms, x: Math.round(x0 + W * dxFrac), y: y0 + dyPx }, { type: "pointerUp", button: 0 },
  ] }])
  await browser.releaseActions()
  await browser.pause(800)
}

describe("Chats gestures", function () {
  this.timeout(300000)
  let fixture
  before(async () => {
    assert.equal(process.env.E2E_BUNDLE_ID, "com.suhai.agents.e2e", "Never run against a production bundle")
    fixture = await startFixture()
    await browser.waitUntil(async () => await shown("server-url") || await shown("login-username") || await shown("chats-list"), { timeout: 30000 })
    if (await shown("server-url")) {
      await $("~server-url").setValue(fixture.url); await tap("server-connect")
      await browser.waitUntil(async () => await shown("login-username") || await shown("chats-list"))
    }
    if (await shown("login-username")) {
      await $("~login-username").setValue("fixture"); await $("~login-password").setValue("fixture"); await tap("login-submit")
    }
    await $("~chats-list").waitForDisplayed()
  })
  after(async () => { if (fixture) await fixture.close() })

  // Back to the chat list from wherever a gesture left us.
  async function home() {
    if (await shown("thread-viewport")) { await browser.back(); await browser.pause(600) }
    if (await shown("side-menu")) {
      // The scrim's centre is under the panel; tap the strip right of it.
      const { width: W, height: H } = await browser.getWindowSize()
      await browser.performActions([{ type: "pointer", id: "t", parameters: { pointerType: "touch" }, actions: [
        { type: "pointerMove", duration: 0, x: W - 16, y: Math.round(H / 2) }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 },
      ] }])
      await browser.releaseActions()
      await browser.pause(500)
    }
    if (!(await shown("chats-list"))) { await tap("tab-Chats"); await $("~chats-list").waitForDisplayed() }
  }
  afterEach(home)

  it("a plain tap on a chat row still opens the chat", async () => {
    await tap(`chat-${SESSION}`)
    await $("~thread-viewport").waitForDisplayed()
  })

  it("a long leftward swipe across a chat row pages to Inbox and never opens the chat", async () => {
    await drag(`chat-${SESSION}`, -0.5)
    assert(!(await shown("thread-viewport")), "the swipe opened the chat")
    assert(await shown("inbox-compose"), "the swipe should page to Inbox")
  })

  // A thumb's swipe is short, fast and a little diagonal, and may start anywhere
  // on the row — including the screen edge. Whatever it does (page, pull the
  // menu, nothing), it must never open the chat under it. [dx, ms, dy, start]
  for (const [dx, ms, dy, x0] of [
    [-0.12, 120, 0], [-0.2, 150, 18], [-0.3, 200, -24], [-0.08, 400, 6],
    [0.1, 150, 0, 0.02], [0.25, 200, 10, 0.02], [0.08, 300, 0, 0.3], [0.5, 250, 0, 0.01],
  ]) {
    it(`a swipe (${dx}, ${ms}ms, dy ${dy}, from ${x0 ?? "default"}) never opens the chat`, async () => {
      await drag(`chat-${SESSION}`, dx, ms, dy, x0)
      assert(!(await shown("thread-viewport")), "the swipe opened the chat")
    })
  }

  it("a rightward swipe across a chat row pulls out the side menu", async () => {
    await drag(`chat-${SESSION}`, 0.5)
    assert(!(await shown("thread-viewport")), "the swipe opened the chat")
    assert(await shown("side-menu"), "the swipe should open the side menu")
  })

  // A thumb's quick swipe right. (The release-velocity flick rule is unit-tested
  // in lib/gestures: XCUITest's synthesized touches carry no release velocity.)
  it("a short quick swipe right opens the menu", async () => {
    await drag(`chat-${SESSION}`, 0.2, 80)
    assert(await shown("side-menu"), "a quick swipe should open the side menu")
  })

  it("a short slow drag right lets the menu fall back shut", async () => {
    await drag(`chat-${SESSION}`, 0.1, 600)
    assert(!(await shown("side-menu")), "a hesitant drag should not leave the menu open")
  })
})
