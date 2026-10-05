const assert = require("node:assert/strict")
const { startFixture } = require("../thread-board-fixture")

const shown = id => $("~" + id).isDisplayed()
async function tap(id) { const el = await $("~" + id); await el.waitForDisplayed(); await el.click() }

// Skills & tools → Marketplace against the fixture's registry shape: browse,
// read an entry, the server's refusals surface in its words, install lands in
// the list. The fixture records every write; nothing else may be written.
describe("Marketplace — browse and install MCP tools and skills", () => {
  let fixture
  const installs = () => fixture.requests.filter(r => r.route.startsWith("POST /api/market"))

  before(async () => {
    assert.equal(process.env.E2E_BUNDLE_ID, "com.suhai.agents.e2e", "Never run against a production bundle")
    fixture = await startFixture({ market: true })
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
    await tap("menu-Capabilities")
    await $("~cap-tab-skills").waitForDisplayed()
  })
  after(async () => {
    if (fixture) {
      await fixture.close()
      assert.deepEqual(fixture.forbidden, [], "Every write must hit a modelled route")
    }
  })

  it("an MCP entry needing a key is refused without it, then installs for all sessions", async () => {
    await tap("cap-tab-mcp")
    await tap("cap-browse-mcp")
    await tap("market-item-io.github.acme/notes-mcp")
    await $("~market-detail").waitForDisplayed()
    assert.equal(await $("~market-scope-project").isExisting(), false, "No session folder → no project scope")
    await tap("market-install")
    assert.match(await $("~market-install-error").getText(), /NOTES_KEY is required/)
    assert.equal(installs().length, 0, "A missing required input never reaches the server")
    await $("~market-input-NOTES_KEY").setValue("secret-key")
    await tap("market-install")
    await browser.waitUntil(async () => installs().length === 1)
    assert.deepEqual(installs()[0].body, { id: "io.github.acme/notes-mcp", values: { NOTES_KEY: "secret-key" }, scope: "global" })
    // The success alert is auto-accepted by WDA; the sheet closes and the list reloads.
    await $("~cap-mcp-notes-mcp").waitForDisplayed()
  })

  it("a Docker-only entry explains itself and offers no Install", async () => {
    await tap("cap-browse-mcp")
    await tap("market-item-io.github.acme/docker-only")
    await $("~market-not-installable").waitForDisplayed()
    assert.equal(await $("~market-install").isExisting(), false)
    await tap("market-back")
    await $("~market-search").waitForDisplayed()
    await tap("market-close")
    await $("~market-search").waitForDisplayed({ reverse: true })
  })

  it("a skill installs and appears in the skills list", async () => {
    await tap("cap-tab-skills")
    await tap("cap-browse-skills")
    await tap("market-item-pdf")
    await tap("market-install")
    await $("~cap-skill-pdf").waitForDisplayed()
    assert.deepEqual(installs().at(-1).body, { id: "pdf", scope: "user" })
  })
})
