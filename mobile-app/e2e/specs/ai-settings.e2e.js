const assert = require("node:assert/strict")
const { startFixture, SESSION, NEW_SESSION, PROVIDER, LONG_MODEL } = require("../thread-board-fixture")
const clone = value => JSON.parse(JSON.stringify(value))
const shown = id => $("~" + id).isDisplayed()
async function tap(id) { const el = await $("~" + id); await el.waitForDisplayed(); await el.click() }
async function scroll(direction = "up") {
  const { width, height } = await browser.getWindowSize()
  const x = Math.round(width * .5), top = Math.round(height * .3), bottom = Math.round(height * .68)
  await browser.performActions([{ type: "pointer", id: "ai-scroll", parameters: { pointerType: "touch" }, actions: [
    { type: "pointerMove", duration: 0, x, y: direction === "up" ? bottom : top },
    { type: "pointerDown", button: 0 },
    { type: "pointerMove", duration: 500, x, y: direction === "up" ? top : bottom },
    { type: "pointerUp", button: 0 },
  ] }])
  await browser.releaseActions()
}
async function reveal(id, direction = "up") {
  for (let n = 0; n < 12; n++) { if (await shown(id)) return; await scroll(direction) }
  assert.fail(`Cannot reveal ${id} after 12 bounded native swipes`)
}
async function readySave() {
  await browser.waitUntil(async () => (await $("~ai-save").getAttribute("enabled")) === "true", { timeoutMsg: "AI save must become enabled after capability loading" })
  await tap("ai-save")
}
async function explicitModel(id) {
  await reveal("ai-model-manual")
  await $("~ai-model-manual").setValue(id)
  await scroll("up") // FlatList keyboardDismissMode=on-drag; no device keyboard config changes.
}
async function selected(id) {
  await reveal(id)
  const row = await $("~" + id)
  const label = await row.getAttribute("label")
  assert(label.includes("✓") || (await row.getAttribute("value")) === "1", `${id} must visibly preserve its selected state`)
}

describe("Native AI settings — isolated transactional API", () => {
  let fixture
  const writes = () => fixture.requests.filter(r => /^POST \/api\/(ai\/defaults|session\/ai|new-session|session-meta)$/.test(r.route))
  async function profileEditor() {
    await $('-ios predicate string:label == "Profile"').click()
    await reveal("profile-ai-defaults")
    await tap("profile-ai-defaults")
    await $("~ai-editor").waitForDisplayed()
  }
  async function closeClean() { await tap("ai-cancel"); await $("~ai-editor").waitForDisplayed({ reverse: true }) }
  async function discard() {
    await tap("ai-cancel")
    await $("~Discard changes").waitForDisplayed()
    await $("~Discard changes").click()
    await $("~ai-editor").waitForDisplayed({ reverse: true })
  }
  async function chats() {
    await $('-ios predicate string:label == "Chats"').click()
    await $("~chats-list").waitForDisplayed()
  }
  before(async () => {
    assert.equal(process.env.E2E_BUNDLE_ID, "com.suhai.agents.e2e", "Never run against a production bundle")
    fixture = await startFixture({ ai: true })
    // Make dirty-dismissal an explicit tested choice, not auto-accepted by WDA.
    await browser.updateSettings({ autoAcceptAlerts: false })
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
  afterEach(async function () {
    if (this.currentTest.state === "failed") console.log("AI_NATIVE_PAGE_SOURCE", await browser.getPageSource())
  })
  after(async () => {
    if (fixture) {
      await fixture.close()
      assert.deepEqual(fixture.forbidden, [], "Only atomic AI/defaults/creation writes are allowed; no post-create metadata or launches")
    }
  })

  it("Profile defaults stages selections, Keep editing preserves draft, discard makes zero writes", async () => {
    await profileEditor()
    const before = writes().length
    await tap(`ai-provider-${PROVIDER}`)
    await tap("ai-cancel")
    await $("~Keep editing").waitForDisplayed()
    await $("~Keep editing").click()
    await selected(`ai-provider-${PROVIDER}`)
    await discard()
    assert.equal(writes().length, before)
    await profileEditor()
    await selected("ai-provider-default")
    await closeClean()
  })

  it("failed defaults save keeps the full draft; retry persists provider/model and leaves existing chat unchanged", async () => {
    await profileEditor()
    const existing = clone(fixture.state.sessions[SESSION])
    await tap(`ai-provider-${PROVIDER}`)
    await explicitModel(LONG_MODEL)
    fixture.state.failNextSave = true
    await readySave()
    await reveal("ai-error", "down")
    assert.equal(fixture.state.defaults.revision, 0)
    await reveal("ai-model-manual")
    assert.equal(await $("~ai-model-manual").getText(), LONG_MODEL)
    await readySave()
    await $("~ai-editor").waitForDisplayed({ reverse: true })
    assert.deepEqual(fixture.state.defaults.selection, { provider: PROVIDER, model: { kind: "id", id: LONG_MODEL }, convMode: "agent", effort: "" })
    assert.deepEqual(fixture.state.sessions[SESSION], existing)
    await profileEditor()
    await selected(`ai-provider-${PROVIDER}`)
    await reveal("ai-model-manual")
    assert.equal(await $("~ai-model-manual").getText(), LONG_MODEL)
    await closeClean()
  })

  it("searches a long discovered list and preserves manual selection across discovery failure/retry", async () => {
    await profileEditor()
    await reveal("ai-model-search")
    await $("~ai-model-search").setValue("full-model-id-139")
    await scroll("up")
    await reveal(`ai-model-${LONG_MODEL}`)
    await tap(`ai-model-${LONG_MODEL}`)
    await reveal("ai-provider-fixture-error", "down")
    await tap("ai-provider-fixture-error")
    const manual = "fixture/manual-not-in-discovery"
    await explicitModel(manual)
    await reveal("ai-discovery-status", "down")
    assert((await $("~ai-discovery-status").getText()).includes("Fixture discovery unavailable"))
    fixture.state.discoveryFailure = false
    await reveal("ai-discovery-retry")
    await tap("ai-discovery-retry")
    await browser.waitUntil(async () => !(await $("~ai-discovery-status").getText()).includes("Fixture discovery unavailable"))
    await reveal("ai-model-manual", "down")
    assert.equal(await $("~ai-model-manual").getText(), manual)
    await discard()
  })

  it("Session saves one AI-only pair, preserves explicit Opus ID on reopen, and resets explicitly", async () => {
    await chats()
    await tap(`chat-${SESSION}`)
    await tap("header-title")
    await reveal("sp-mode-bypass")
    await tap("sp-mode-bypass")
    await browser.waitUntil(() => fixture.state.permissionMode === "bypass")
    assert.deepEqual(fixture.requests.filter(r => r.route === "POST /api/session/mode").at(-1).body, { for_session: SESSION, mode: "bypass" })
    await browser.back(); await tap("header-title")
    await reveal("sp-mode-bypass")
    assert.equal(await $("~sp-mode-bypass").getAttribute("value"), "1", "Saved permission policy is selected after reopening")
    await reveal("sp-ai-row", "down")
    await tap("sp-ai-row")
    const opus = "claude-opus-4-6" // An explicit regression ID, not an entitlement catalog.
    await explicitModel(opus)
    await readySave()
    await $("~ai-editor").waitForDisplayed({ reverse: true })
    const saved = writes().at(-1)
    assert.equal(saved.route, "POST /api/session/ai")
    assert.deepEqual(Object.keys(saved.body).sort(), ["agent", "host", "id", "revision", "selection"])
    assert.equal(saved.body.id, SESSION)
    assert.deepEqual(saved.body.selection.model, { kind: "id", id: opus })
    await tap("sp-ai-row")
    await reveal("ai-model-manual")
    assert.equal(await $("~ai-model-manual").getText(), opus)
    await reveal("ai-model-default", "down")
    await tap("ai-model-default")
    await readySave()
    await $("~ai-editor").waitForDisplayed({ reverse: true })
    assert.deepEqual(fixture.state.sessions[SESSION].selection.model, { kind: "default" })
    await browser.back(); await $("~thread-viewport").waitForDisplayed()
    await browser.back(); await $("~chats-list").waitForDisplayed()
  })

  it("NewChat inherits defaults, stages its own pair without writes, and includes it in the first create payload", async () => {
    const defaults = clone(fixture.state.defaults)
    const before = writes().length
    await tap("new-chat-button")
    await reveal("newchat-ai-row")
    await tap("newchat-ai-row")
    await selected(`ai-provider-${PROVIDER}`)
    await tap("ai-provider-fixture-beta")
    await explicitModel("fixture/beta-first-turn-model")
    await readySave()
    await $("~ai-editor").waitForDisplayed({ reverse: true })
    assert.equal(writes().length, before, "Use for this chat is local draft only")
    await reveal("newchat-message", "down")
    await $("~newchat-message").setValue("Fixture first message; never launches a real agent")
    await reveal("newchat-start")
    await tap("newchat-start")
    await browser.waitUntil(() => fixture.state.creations.length === 1)
    await $("~thread-viewport").waitForDisplayed({ timeout: 30000 })
    assert.equal(writes().length, before + 1, "Exactly one atomic creation, no later provider metadata write")
    assert.deepEqual(fixture.state.creations[0].ai, { provider: "fixture-beta", model: { kind: "id", id: "fixture/beta-first-turn-model" }, convMode: "agent", effort: "" })
    assert.deepEqual(fixture.state.defaults, defaults)
    assert.deepEqual(fixture.state.sessions[NEW_SESSION].selection, fixture.state.creations[0].ai)
  })
})
