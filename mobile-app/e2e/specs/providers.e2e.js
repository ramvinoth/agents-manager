const assert = require("node:assert/strict")
const { startFixture, PROVIDER } = require("../thread-board-fixture")
const shown = id => $("~" + id).isDisplayed()

async function tap(id) { await reveal(id); await $("~" + id).click() }
// Bounded native swipes until the control is in the upper 70% (clear of keyboard and tab bar).
async function reveal(id) {
  for (let n = 0; n < 8; n++) {
    const { width, height } = await browser.getWindowSize()
    const el = await $("~" + id)
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

describe("Providers — one connection, a context window per model", function () {
  this.timeout(240000)
  let fixture
  before(async () => {
    assert.equal(process.env.E2E_BUNDLE_ID, "com.suhai.agents.e2e", "Never run against a production bundle")
    fixture = await startFixture({ ai: true })
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

  it("discovers per-model windows, overrides one, changes the default and saves overrides", async () => {
    await $("~tab-Profile").click()
    await tap("open-providers")
    await tap(`provider-edit-${PROVIDER}`)
    await $("~provider-name").waitForDisplayed()

    await tap("provider-load-models")
    await $("~provider-discovery-status").waitForDisplayed({ timeout: 15000 })
    assert.match(await label("provider-discovery-status"), /3 models found; the endpoint reports a context window for 2/)
    // A window reported by the endpoint is shown with its source; an unknown one says so.
    assert.match(await label("provider-model-fixture-alpha-large"), /262K/)
    assert.match(await label("provider-model-fixture-alpha-large"), /reported by the endpoint/)

    await reveal("provider-override-fixture-alpha-mystery")
    await $("~provider-override-fixture-alpha-mystery").setValue("64k")
    await tap("provider-model-fixture-alpha-large")
    assert.equal(await (await $("~provider-error")).isExisting(), false)

    await tap("provider-save")
    await $("~provider-add").waitForDisplayed({ timeout: 15000 })
    assert.equal(fixture.state.providerSaves.length, 1)
    const body = fixture.state.providerSaves[0]
    assert.equal(body.id, PROVIDER)
    assert.equal(body.model, "fixture-alpha-large")
    assert.deepEqual(body.modelOverrides, { "fixture-alpha-mystery": 64000 })
    assert.equal("contextLimit" in body, false)
    assert.deepEqual(fixture.forbidden, [])
  })
})
