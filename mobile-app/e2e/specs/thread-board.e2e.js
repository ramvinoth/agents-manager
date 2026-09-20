const assert = require("node:assert/strict")
const { startFixture, SESSION } = require("../thread-board-fixture")

// Native W3C pointer actions, not JS callbacks or an alternate renderer.
async function drag(points) {
  await browser.performActions([{ type: "pointer", id: "finger", parameters: { pointerType: "touch" }, actions: [
    { type: "pointerMove", duration: 0, x: Math.round(points[0][0]), y: Math.round(points[0][1]) },
    { type: "pointerDown", button: 0 },
    ...points.slice(1).map(([x, y]) => ({ type: "pointerMove", duration: 220, x: Math.round(x), y: Math.round(y) })),
    { type: "pointerUp", button: 0 },
  ] }])
  await browser.releaseActions()
}
async function rect(id) { return browser.getElementRect((await $(id)).elementId) }
async function edgeSwipe(distance = 150) {
  const r = await rect("~thread-viewport")
  await drag([[r.x + r.width - 8, r.y + r.height * 0.5], [r.x + r.width - 8 - distance, r.y + r.height * 0.5]])
}
async function threadVisible() { await $("~thread-viewport").waitForDisplayed(); assert.equal(await $("~kanban-board").isDisplayed(), false) }
async function backToThread() { await browser.back(); await threadVisible() }

describe("Native thread board gesture — isolated API", () => {
  let fixture
  before(async () => {
    assert.equal(process.env.E2E_BUNDLE_ID, "com.suhai.agents.e2e", "Use run-ios.sh's isolated app, never a production install")
    fixture = await startFixture()
    await browser.waitUntil(async () => (await $("~server-url").isDisplayed()) || (await $("~login-username").isDisplayed()) || (await $("~chats-list").isDisplayed()), { timeout: 30000 })
    if (await $("~server-url").isDisplayed()) {
      await $("~server-url").setValue(fixture.url)
      await $("~server-connect").click()
      await browser.waitUntil(async () => (await $("~login-username").isDisplayed()) || (await $("~chats-list").isDisplayed()))
    }
    if (await $("~login-username").isDisplayed()) {
      await $("~login-username").setValue("fixture")
      await $("~login-password").setValue("fixture")
      await $("~login-submit").click()
    }
    await $(`~chat-${SESSION}`).waitForDisplayed()
    await $(`~chat-${SESSION}`).click()
    await $("~thread-viewport").waitForDisplayed()
  })
  after(async () => {
    if (fixture) {
      await fixture.close()
      assert.deepEqual(fixture.forbidden, [], "No chat, card mutation or other unsupported write may be attempted")
    }
  })
  afterEach(async function () {
    if (this.currentTest.state === "failed") console.log("NATIVE_PAGE_SOURCE", await browser.getPageSource())
  })

  it("opens this session's real board from the right transcript edge, repeatedly", async () => {
    for (let i = 0; i < 2; i++) {
      await edgeSwipe()
      await $("~kanban-board").waitForDisplayed()
      await $("~kanban-card-201").waitForDisplayed()
      assert(fixture.requests.some(r => r.route === "GET /api/org/board" && new URLSearchParams(r.search).get("session") === SESSION))
      await backToThread()
    }
  })

  it("retains the accessible Board menu and real user/agent card detail move chips", async () => {
    await $("~thread-more").click()
    await $("~Board").click()
    await $("~kanban-board").waitForDisplayed()
    for (const id of [201, 202]) {
      await $(`~kanban-card-${id}`).click()
      await $("~card-detail-col-102").waitForDisplayed()
      await $("~card-detail-col-103").waitForDisplayed()
      await browser.back()
    }
    await backToThread()
  })

  it("rejects a short edge swipe and reversed completion", async () => {
    await edgeSwipe(30)
    await threadVisible()
    const r = await rect("~thread-viewport")
    const x = r.x + r.width - 8, y = r.y + r.height * 0.5
    await drag([[x, y], [x - 90, y], [x - 10, y]])
    await threadVisible()
  })

  it("rejects a two-finger board swipe", async () => {
    const r = await rect("~thread-viewport")
    await browser.performActions([0, 1].map(i => ({
      type: "pointer", id: `multi-${i}`, parameters: { pointerType: "touch" }, actions: [
        { type: "pointerMove", duration: 0, x: Math.round(r.x + r.width - 8), y: Math.round(r.y + r.height * 0.5 + i * 45) },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", duration: 450, x: Math.round(r.x + r.width - 160), y: Math.round(r.y + r.height * 0.5 + i * 45) },
        { type: "pointerUp", button: 0 },
      ],
    })))
    await browser.releaseActions()
    await threadVisible()
  })

  it("preserves rightward message swipe-to-reply", async () => {
    const reply = await $('-ios predicate string:label == "Native reply target"')
    await reply.waitForDisplayed()
    const r = await browser.getElementRect(reply.elementId)
    await drag([[r.x + 8, r.y + r.height / 2], [r.x + 115, r.y + r.height / 2]])
    await $("~reply-cancel").waitForDisplayed()
    // The quote must contain this message, not a stale previous selection.
    const copies = await $$('-ios predicate string:type == "XCUIElementTypeStaticText" AND label == "Native reply target"')
    assert.equal(copies.length, 2, "Original bubble and composer quote must both contain the selected message")
    await $("~reply-cancel").click()
    await threadVisible()
  })

  it("allows vertical transcript scrolling without navigating", async () => {
    const r = await rect("~thread-viewport")
    await drag([[r.x + r.width / 2, r.y + 50], [r.x + r.width / 2, r.y + r.height - 60]])
    await $("~jump-to-latest").waitForDisplayed()
    await threadVisible()
    await $("~jump-to-latest").click()
  })

  it("does not intercept nested code/table horizontal drags", async () => {
    for (const marker of ["CODE_START", "TABLE_START"]) {
      const text = await $(`-ios predicate string:type == "XCUIElementTypeStaticText" AND label BEGINSWITH "${marker}"`)
      await text.waitForDisplayed()
      const r = await browser.getElementRect(text.elementId)
      const viewport = await rect("~thread-viewport")
      // Start within the actual nested scroll view, not the board's edge strip.
      const x = Math.min(r.x + 180, viewport.x + viewport.width - 45)
      await drag([[x, r.y + r.height / 2], [r.x + 8, r.y + r.height / 2]])
      await threadVisible()
      const after = await browser.getElementRect(text.elementId)
      assert(after.x < r.x, `${marker} must visibly scroll, not merely avoid board navigation`)
    }
  })

  it("keeps edge bounds correct with the keyboard visible", async () => {
    await $("~composer-input").click()
    await edgeSwipe()
    await $("~kanban-board").waitForDisplayed()
    await backToThread()
  })

  // WDA 11.1.5 preprocesses pointerCancel by deleting the preceding action,
  // rather than dispatching UIKit touchesCancelled. Do not report that as native
  // PanResponder termination coverage (predicate/unit coverage is separate).
  it.skip("rejects an OS-cancelled in-flight swipe (WDA cannot synthesize touchesCancelled)", () => {})

  it("preserves portrait layout after a device rotation attempt", async () => {
    await browser.setOrientation("LANDSCAPE")
    await browser.setOrientation("PORTRAIT")
    await threadVisible()
    await edgeSwipe()
    await $("~kanban-board").waitForDisplayed()
    await backToThread()
  })

  it("preserves native left-edge back", async () => {
    const r = await rect("~thread-viewport")
    await drag([[2, r.y + r.height * 0.5], [r.width * 0.8, r.y + r.height * 0.5]])
    await $("~chats-list").waitForDisplayed()
  })
})
