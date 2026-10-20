const assert = require("node:assert/strict")
const { startFixture, SESSION } = require("../thread-board-fixture")

// Typing "#fs" and picking a file replaces the "#fs" term with the @mention
// (user report: the pick produced "#fs@viewer/routes/fs.py").
describe("Composer # file mention", function () {
  this.timeout(180000)
  let fixture
  before(async () => {
    fixture = await startFixture()
    await browser.waitUntil(async () => (await $("~server-url").isDisplayed()) || (await $("~login-username").isDisplayed()) || (await $("~chats-list").isDisplayed()), { timeout: 30000 })
    if (await $("~server-url").isDisplayed()) { await $("~server-url").setValue(fixture.url); await $("~server-connect").click(); await browser.waitUntil(async () => (await $("~login-username").isDisplayed()) || (await $("~chats-list").isDisplayed())) }
    if (await $("~login-username").isDisplayed()) { await $("~login-username").setValue("fixture"); await $("~login-password").setValue("fixture"); await $("~login-submit").click() }
    await $(`~chat-${SESSION}`).waitForDisplayed(); await $(`~chat-${SESSION}`).click()
    await $("~thread-viewport").waitForDisplayed()
  })
  after(async () => { await fixture?.close() })

  // The first pick after opening the thread is the one that failed: the iOS
  // keyboard echoed "#fs" back over the mention. Repeat to cover later picks.
  for (const [typed, want] of [["#fs", "@viewer/routes/fs.py "], ["see #fs", "see @viewer/routes/fs.py "], ["#fs", "@viewer/routes/fs.py "]]) {
    it(`replaces "${typed}" with the picked file`, async () => {
      const input = await $("~composer-input")
      await input.clearValue()
      await input.addValue(typed)
      const row = await $("~file-mention-viewer/routes/fs.py")
      await row.waitForDisplayed({ timeout: 10000 })
      await row.click()
      await browser.pause(500)
      assert.equal(await input.getText(), want)
      await input.addValue("x")
      await browser.pause(300)
      assert.equal(await input.getText(), want + "x")
    })
  }
})
