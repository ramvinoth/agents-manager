const assert = require("node:assert/strict")
const { startFixture } = require("../thread-board-fixture")

const shown = id => $("~" + id).isDisplayed()
async function tap(id) { const el = await $("~" + id); await el.waitForDisplayed(); await el.click() }
async function scroll(up = false) {
  const { width, height } = await browser.getWindowSize()
  const x = Math.round(width * .5)
  const [from, to] = up ? [.3, .65] : [.55, .2]
  await browser.performActions([{ type: "pointer", id: "int-scroll", parameters: { pointerType: "touch" }, actions: [
    { type: "pointerMove", duration: 0, x, y: Math.round(height * from) }, { type: "pointerDown", button: 0 },
    { type: "pointerMove", duration: 500, x, y: Math.round(height * to) }, { type: "pointerUp", button: 0 },
  ] }])
  await browser.releaseActions()
}
// Down first, then back up: the screen is longer than two pages and specs move both ways.
async function reveal(id) {
  for (let n = 0; n < 16; n++) { if (await shown(id)) return; await scroll(n >= 8) }
  assert.fail(`Cannot reveal ${id} after 16 bounded native swipes`)
}
// A native Switch reports value "1"; an op chip (role switch) reports its checked state the same way.
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
    await tap("menu-button")
    await tap("menu-Integrations")
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
    assert(!(await $("~root-edit-dr-fixture").isExisting()), "A collapsed row keeps its details (folder limit) hidden")
    const { width } = await browser.getWindowSize()
    const sw = await $("~service-switch-google.drive")
    const x = (await sw.getLocation()).x + (await sw.getSize()).width
    assert(x <= width, `Drive switch must lie inside the screen (right edge ${x} > ${width})`)
    assert(!(await $("~service-google.keep").isExisting()), "Keep can never be connected: no dead row on the account")
    await reveal("integration-unavailable-google")
    assert.match(await $("~integration-unavailable-google").getText(), /Keep can't be connected/)
  })

  it("a switch writes the owner's choice and reflects the server's view", async () => {
    await tap("service-switch-google.calendar")
    await browser.waitUntil(() => switchOn("service-switch-google.calendar"), { timeoutMsg: "Calendar switch must turn on" })
    assert.deepEqual(writes().at(-1).body, { connection: "dr-fixture", service: "google.calendar", on: true })
  })

  it("ops: a chip per operation once the service is on; a click writes the owner's choice", async () => {
    // Calendar was switched on above, which opens its row: op chips default create/update on, delete off.
    await reveal("op-dr-fixture-google.calendar-delete")
    assert(!(await switchOn("op-dr-fixture-google.calendar-delete")), "Calendar delete defaults off for agents")
    await tap("op-dr-fixture-google.calendar-delete")
    await browser.waitUntil(() => switchOn("op-dr-fixture-google.calendar-delete"), { timeoutMsg: "Delete must turn on" })
    assert.deepEqual(writes().at(-1).body, { connection: "dr-fixture", service: "google.calendar", op: "delete", on: true })
    assert(!(await $("~op-dr-fixture-google.gmail-read").isExisting()), "No op chips under a service that is not granted")
  })

  it("a files account can be narrowed to one folder; a missing folder is refused with the server's words", async () => {
    await reveal("service-expand-google.drive")
    await tap("service-expand-google.drive")
    await reveal("root-edit-dr-fixture")
    await tap("root-edit-dr-fixture")
    await $("~root-input-dr-fixture").setValue("/Missing")
    await tap("root-save-dr-fixture")
    await reveal("integrations-error")
    assert.match(await $("~integrations-error").getText(), /No such folder/)
    await reveal("root-edit-dr-fixture")
    await tap("root-edit-dr-fixture")
    await $("~root-input-dr-fixture").setValue("/Work")
    await tap("root-save-dr-fixture")
    await browser.waitUntil(async () => (await $("~root-dr-fixture").getText()) === "Only /Work", { timeoutMsg: "Root must show the folder" })
    assert.deepEqual(writes().at(-1).body, { connection: "dr-fixture", root: "/Work" })
    assert(!(await shown("integrations-error")), "A good save clears the error")
  })

  it("this machine: add a folder and allow deletes", async () => {
    await reveal("local-add-input")
    await $("~local-add-input").setValue("~/Projects")
    await tap("local-add")
    await reveal("local-root-1")
    assert.equal(await $("~local-root-1").getText(), "~/Projects")
    assert.deepEqual(writes().at(-1).body, { roots: ["~", "~/Projects"], ops: ["read", "write"] })
    await reveal("local-op-delete")
    await tap("local-op-delete")
    await browser.waitUntil(() => switchOn("local-op-delete"), { timeoutMsg: "Local delete must turn on" })
    assert.deepEqual(writes().at(-1).body, { roots: ["~", "~/Projects"], ops: ["read", "write", "delete"] })
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
