const assert = require("node:assert/strict")
const { startFixture } = require("../thread-board-fixture")

const shown = id => $("~" + id).isDisplayed()
async function tap(id) { const el = await $("~" + id); await el.waitForDisplayed(); await el.click() }
// Native scroll: wdio's scrollIntoView is a web script (a no-op in the app) and
// "mobile: scroll toVisible" hangs on RN lists, so drag a third of a screen at a time.
async function reveal(id) {
  const el = await $("~" + id)
  await el.waitForExist()
  for (let i = 0; i < 12 && !(await el.isDisplayed()); i++)
    await browser.execute("mobile: dragFromToForDuration", { fromX: 200, fromY: 600, toX: 200, toY: 330, duration: 0.2 })
  await el.waitForDisplayed({ timeout: 2000 })
  await browser.pause(600) // let scroll momentum stop, or the next tap only halts the scroll
}
const shot = async name => { if (process.env.E2E_SHOT_DIR) await browser.saveScreenshot(`${process.env.E2E_SHOT_DIR}/agent-edit-${name}.png`) }

// Agents → Edit: a short grouped-inset list of settings rows. Skills and MCP
// tools drill into their own screen, Board access picks from the app sheet, a
// job's row offers Edit / Remove in one sheet, and Save sends exactly the changed agent.
describe("Edit agent — grouped settings rows", () => {
  let fixture
  const updates = () => fixture.requests.filter(r => r.route === "POST /api/agent-templates/update")

  before(async () => {
    assert.equal(process.env.E2E_BUNDLE_ID, "com.suhai.agents.e2e", "Never run against a production bundle")
    fixture = await startFixture({ agents: true, ai: true })
    await browser.waitUntil(async () => await shown("server-url") || await shown("login-username") || await shown("chats-list"), { timeout: 30000 })
    if (await shown("server-url")) {
      // setValue can drop keystrokes on a cold keyboard ("h://..."): retype until it reads back right.
      const url = await $("~server-url")
      // (clearValue can't empty a controlled RN input, so backspace it out.)
      await url.setValue(fixture.url)
      for (let i = 0; i < 3 && (await url.getAttribute("value")) !== fixture.url; i++) {
        await url.addValue("\b".repeat(120)); await url.addValue(fixture.url)
      }
      await tap("server-connect")
      await browser.waitUntil(async () => await shown("login-username") || await shown("chats-list")).catch(async e => { await shot("connect-fail"); throw e })
    }
    if (await shown("login-username")) {
      await $("~login-username").setValue("fixture"); await $("~login-password").setValue("fixture"); await tap("login-submit")
    }
    await $("~chats-list").waitForDisplayed()
    await tap("menu-button")
    await tap("menu-Agents")
    await tap("agent-more-7")
    await $("~Edit").click()
    await $("~agent-name").waitForDisplayed()
  })
  after(async () => {
    if (fixture) {
      await fixture.close()
      assert.deepEqual(fixture.forbidden, [], "Every write must hit a modelled route")
    }
  })

  it("shows identity, AI and plugins as rows, without fixture errors", async () => {
    assert.equal(await $("~agent-name").getText(), "Writing Coach")
    await $("~agent-ai-row").waitForDisplayed()
    await $("~agent-plugins-row").waitForDisplayed()
    assert.equal(await $("~agent-extras-retry").isExisting(), false, "Extras loaded")
    assert.equal(await $("~agent-ai-retry").isExisting(), false, "AI config loaded")
    assert.match(await $("~agent-category").getAttribute("label"), /Category, Personal/)
    await shot("top")
  })

  it("Category opens the app sheet, marks the current one, and a pick applies it", async () => {
    await tap("agent-category")
    await $("~action-sheet").waitForDisplayed()
    await $("~Personal  ✓").waitForDisplayed()
    await shot("category-sheet")
    await tap("Design")
    await $("~action-sheet").waitForExist({ reverse: true })
    await browser.waitUntil(async () => /Category, Design/.test(await $("~agent-category").getAttribute("label")))
  })

  it("Skills and MCP tools drill into their own screen, each with an Add row", async () => {
    await reveal("agent-skills-row")
    await tap("agent-skills-row")
    await $("~agent-skill-weekly-review").waitForDisplayed()
    await $("~agent-add-skill").waitForDisplayed()
    assert.equal(await $("~agent-tools-retry").isExisting(), false, "Skills loaded")
    await shot("skills")
    await browser.back()
    await reveal("agent-mcps-row")
    await tap("agent-mcps-row")
    await $("~agent-mcp-notes").waitForDisplayed()
    await $("~agent-add-mcp").waitForDisplayed()
    await shot("mcp")
    await browser.back()
    await $("~agent-mcps-row").waitForDisplayed()
  })

  it("Board access picks from the sheet and a job row removes through its sheet, then Save writes once", async () => {
    await reveal("agent-level")
    await tap("agent-level")
    await $("~action-sheet").waitForDisplayed()
    await $("~Own work  ✓").waitForDisplayed()
    await tap("Workspace")
    await $("~action-sheet").waitForExist({ reverse: true })
    await browser.waitUntil(async () => /Board access, Workspace/.test(await $("~agent-level").getAttribute("label")))
    await reveal("agent-job-0")
    await shot("level-jobs")
    await tap("agent-job-0")
    await $("~action-sheet").waitForDisplayed()
    await shot("job-sheet")
    await tap("Remove job")
    await browser.waitUntil(async () => !(await $("~agent-job-0").isExisting()))
    await reveal("agent-delete")
    await shot("bottom")
    await tap("agent-save")
    await browser.waitUntil(async () => updates().length === 1)
    const body = updates()[0].body
    assert.equal(body.id, 7)
    assert.equal(body.level, "lead")
    assert.deepEqual(body.jobs, [])
    assert.equal(body.name, "Writing Coach")
    assert.equal(body.category, "design")
  })
})
