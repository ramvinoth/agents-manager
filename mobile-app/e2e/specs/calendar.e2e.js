const assert = require("node:assert/strict")
const { startFixture } = require("../thread-board-fixture")

const shown = id => $("~" + id).isDisplayed()
async function tap(id) { const el = await $("~" + id); await el.waitForDisplayed(); await el.click() }

// Calendar against the stateful fixture: the Google account's Calendar starts
// OFF, so the screen first shows its empty state; switching it on in
// Integrations makes the agenda appear with the fixture's event today.
describe("Native calendar — agenda, create, edit, delete", () => {
  let fixture
  const writes = () => fixture.requests.filter(r => r.route.startsWith("POST /api/calendar"))

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
    // The delete confirm is a native alert this spec taps itself; WDA's configured
    // autoAcceptAlerts would otherwise dismiss it first. Runtime honours only defaultAlertAction.
    await browser.updateSettings({ defaultAlertAction: "" })
  })
  after(async () => {
    if (fixture) {
      await fixture.close()
      assert.deepEqual(fixture.forbidden, [], "Every write must hit a modelled route")
    }
  })

  it("with no calendar switched on, says so and links to Integrations", async () => {
    await tap("menu-button")
    await tap("menu-Calendar")
    await $("~calendar-empty").waitForDisplayed()
    await tap("calendar-connect")
    await $("~integrations-screen").waitForDisplayed()
    await tap("service-switch-google.calendar")
    await browser.waitUntil(async () => (await $("~service-switch-google.calendar").getAttribute("value")) === "1")
    await driver.back()
  })

  it("lists today's event; an edit-granted account offers +", async () => {
    await $("~event-ev-0").waitForDisplayed({ timeout: 10000 })
    assert(!(await shown("calendar-error")))
    // The fixture grants calendar editing (ops are off/on, never "grant") — so "+" shows.
    assert(await shown("calendar-add"), "An edit-granted account offers +")
    assert(!(await $("~calendar-allow-edit").isExisting()))
  })

  it("creates an event", async () => {
    await tap("calendar-add")
    await $("~event-sheet").waitForDisplayed()
    await $("~event-title").setValue("Fixture lunch")
    await tap("event-save")
    await $("~event-ev-2").waitForDisplayed({ timeout: 10000 })
    const body = writes().at(-1).body
    assert.equal(fixture.requests.filter(r => r.route === "POST /api/calendar/create").length, 1)
    assert.equal(body.title, "Fixture lunch")
    assert.equal(body.connection, "dr-fixture")
    assert.match(body.start, /T\d\d:00:00[+-]\d\d:\d\d$/, "Starts on a whole hour with the device offset")
  })

  it("edits and deletes an event", async () => {
    await tap("event-ev-0")
    await $("~event-title").setValue("Renamed standup")
    await tap("event-save")
    await browser.waitUntil(async () => !(await $("~event-sheet").isDisplayed().catch(() => false)))
    assert.equal(writes().at(-1).route, "POST /api/calendar/update")
    assert.equal(writes().at(-1).body.title, "Renamed standup")
    await tap("event-ev-0")
    await tap("event-delete")
    const confirm = await $("-ios predicate string:type == 'XCUIElementTypeButton' AND label == 'Delete'")
    await confirm.waitForDisplayed()
    await confirm.click()
    await browser.waitUntil(async () => !(await $("~event-ev-0").isExisting()), { timeoutMsg: "Deleted event must leave the agenda" })
    assert.deepEqual(writes().at(-1).body, { id: "ev-0", connection: "dr-fixture" })
  })
})
