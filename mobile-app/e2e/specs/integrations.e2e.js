const assert = require("node:assert/strict")
const { startFixture } = require("../thread-board-fixture")

const shown = id => $("~" + id).isDisplayed()
async function tap(id) { const el = await $("~" + id); await el.waitForDisplayed(); await el.click() }
async function scroll() {
  const { width, height } = await browser.getWindowSize()
  const x = Math.round(width * .5)
  await browser.performActions([{ type: "pointer", id: "int-scroll", parameters: { pointerType: "touch" }, actions: [
    { type: "pointerMove", duration: 0, x, y: Math.round(height * .55) }, { type: "pointerDown", button: 0 },
    { type: "pointerMove", duration: 500, x, y: Math.round(height * .2) }, { type: "pointerUp", button: 0 },
  ] }])
  await browser.releaseActions()
}
async function reveal(id) {
  for (let n = 0; n < 10; n++) { if (await shown(id)) return; await scroll() }
  assert.fail(`Cannot reveal ${id} after 10 bounded native swipes`)
}
const switchOn = async id => (await $("~" + id).getAttribute("value")) === "1"

// Integrations against a stateful local fixture: one Google account carrying every
// service state (on / off / grant / unavailable) and an unconfigured Dropbox client.
// Grant access is never tapped — it opens the system browser on a real consent page.
describe("Native integrations — one catalog, every service state", () => {
  let fixture
  const writes = () => fixture.requests.filter(r => r.route.startsWith("POST /api/integrations"))

  before(async () => {
    assert.equal(process.env.E2E_BUNDLE_ID, "com.suhai.agents.e2e", "Never run against a production bundle")
    fixture = await startFixture({ integrations: true })
    await browser.waitUntil(async () => await shown("server-url") || await shown("login-username") || await shown("chats-list"), { timeout: 30000 })
    if (await shown("server-url")) {
      await $("~server-url").setValue(fixture.url); await tap("server-connect")
      await browser.waitUntil(async () => await shown("login-username") || await shown("chats-list"))
    }
    if (await shown("login-username")) {
      await $("~login-username").setValue("fixture"); await $("~login-password").setValue("fixture"); await tap("login-submit")
    }
    await $("~chats-list").waitForDisplayed()
    await tap("tab-Profile")
    await reveal("open-integrations")
    await tap("open-integrations")
    await $("~integrations-screen").waitForDisplayed()
  })
  after(async () => {
    if (fixture) {
      await fixture.close()
      assert.deepEqual(fixture.forbidden, [], "Every integrations write must hit a modelled route")
    }
  })

  it("renders each service state with its own control and no error", async () => {
    assert(!(await shown("integrations-error")), "The catalog must load without an error banner")
    assert(await shown("integration-conn-dr-fixture"), "The connected Google account is listed")
    assert(await switchOn("service-switch-google.drive"), "Drive is on")
    assert(!(await switchOn("service-switch-google.calendar")), "Calendar is granted but off")
    assert(await shown("service-grant-google.gmail"), "Gmail is not granted yet: offers Grant access")
    const { width } = await browser.getWindowSize()
    const sw = await $("~service-switch-google.drive")
    const x = (await sw.getLocation()).x + (await sw.getSize()).width
    assert(x <= width, `Drive switch must lie inside the screen (right edge ${x} > ${width})`)
    await reveal("service-google.keep")
    assert(!(await $("~service-switch-google.keep").isExisting()) && !(await $("~service-grant-google.keep").isExisting()),
      "Keep is unavailable: neither a switch nor a grant")
  })

  it("a switch writes the owner's choice and reflects the server's view", async () => {
    await tap("service-switch-google.calendar")
    await browser.waitUntil(() => switchOn("service-switch-google.calendar"), { timeoutMsg: "Calendar switch must turn on" })
    assert.deepEqual(writes().at(-1).body, { connection: "dr-fixture", service: "google.calendar", on: true })
  })

  it("setting up a public client needs only the id and unlocks connecting", async () => {
    await reveal("integrations-edit-dropbox")
    await tap("integrations-edit-dropbox")
    assert(!(await $("~integrations-client-secret").isExisting()), "Dropbox is a PKCE public client: no secret field")
    await $("~integrations-client-id").setValue("fixture-app-key")
    await scroll() // a drag dismisses the keyboard that covers Save
    await reveal("integrations-save")
    await tap("integrations-save")
    await reveal("integration-new-dropbox.files")
    assert.deepEqual(writes().at(-1).body, { provider: "dropbox", client_id: "fixture-app-key" })
    assert(!(await shown("integrations-error")))
  })
})
