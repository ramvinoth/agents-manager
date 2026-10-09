const assert = require("node:assert/strict")
const { startFixture, SESSION } = require("../thread-board-fixture")
const shown = id => $("~" + id).isDisplayed()
async function tap(id) { const el = await $("~" + id); await el.waitForDisplayed(); await el.click() }
async function reveal(id) {
  for (let n = 0; n < 10; n++) {
    if (await shown(id)) return
    const { width, height } = await browser.getWindowSize()
    const x = Math.round(width * .5)
    await browser.performActions([{ type: "pointer", id: "j", parameters: { pointerType: "touch" }, actions: [
      { type: "pointerMove", duration: 0, x, y: Math.round(height * .6) }, { type: "pointerDown", button: 0 },
      { type: "pointerMove", duration: 500, x, y: Math.round(height * .3) }, { type: "pointerUp", button: 0 },
    ] }])
    await browser.releaseActions()
  }
  assert.fail(`Cannot reveal ${id}`)
}
// The job sheet's buttons must sit fully above the system keyboard, not behind it.
async function aboveKeyboard(id) {
  const kb = await $("-ios class chain:**/XCUIElementTypeKeyboard")
  await kb.waitForDisplayed()
  const kbTop = (await kb.getLocation()).y
  const el = await $("~" + id)
  assert(await el.isDisplayed(), `${id} is on screen with the keyboard up`)
  const { y } = await el.getLocation(), { height } = await el.getSize()
  assert(y + height <= kbTop, `${id} bottom ${y + height} must be above the keyboard top ${kbTop}`)
}

describe("Scheduled jobs — add and edit in a bottom sheet, buttons clear of the keyboard", function () {
  this.timeout(300000)
  let fixture
  before(async () => {
    assert.equal(process.env.E2E_BUNDLE_ID, "com.suhai.agents.e2e", "Never run against a production bundle")
    fixture = await startFixture({ jobs: true })
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
  after(async () => {
    if (fixture) {
      await fixture.close()
      assert.deepEqual(fixture.forbidden, [], "No write beyond the job create/edit")
    }
  })

  it("adds a job from the sheet: one create, sheet closes", async () => {
    await tap(`chat-${SESSION}`)
    await tap("header-title")
    await reveal("sp-card-automation")
    await tap("sp-card-automation")
    await reveal("sp-job-new")
    await tap("sp-job-new")
    await $("~job-prompt").waitForDisplayed()
    await $("~job-prompt").setValue("Summarise the board")
    await aboveKeyboard("job-add")
    await aboveKeyboard("job-cancel")
    await tap("job-interval-amount") // the numeric pad is a different keyboard height
    await aboveKeyboard("job-add")
    await tap("job-add")
    await browser.waitUntil(() => fixture.jobWrites.length === 1, { timeoutMsg: "Add must send one create" })
    assert.equal(fixture.jobWrites[0].route, "POST /api/loops")
    assert.equal(fixture.jobWrites[0].body.prompt, "Summarise the board")
    await $("~job-prompt").waitForDisplayed({ reverse: true })
    await $("~sp-job-job-1").waitForDisplayed()
  })

  it("edits a job in the same sheet, pre-filled; Save sends one edit", async () => {
    await tap("sp-job-job-1")
    await $("~job-prompt").waitForDisplayed()
    assert.equal(await $("~job-prompt").getText(), "Summarise the board", "Edit opens with the saved prompt")
    await $("~job-prompt").setValue("Summarise the board twice")
    await aboveKeyboard("job-add")
    await tap("job-add")
    await browser.waitUntil(() => fixture.jobWrites.length === 2, { timeoutMsg: "Save must send one edit" })
    assert.deepEqual([fixture.jobWrites[1].route, fixture.jobWrites[1].body.id, fixture.jobWrites[1].body.prompt],
      ["POST /api/loops/edit", "job-1", "Summarise the board twice"])
    await $("~job-prompt").waitForDisplayed({ reverse: true })
  })

  it("a fresh Add after an edit starts blank", async () => {
    await reveal("sp-job-new")
    await tap("sp-job-new")
    await $("~job-prompt").waitForDisplayed()
    assert(!(await $("~job-prompt").getText()).includes("Summarise"), "New job form must not carry the last edit")
    await tap("job-cancel")
    await $("~job-prompt").waitForDisplayed({ reverse: true })
    assert.equal(fixture.jobWrites.length, 2, "Cancel writes nothing")
  })
})
