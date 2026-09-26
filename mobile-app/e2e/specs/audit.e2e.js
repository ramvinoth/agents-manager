const assert = require("node:assert/strict")
const { startFixture } = require("../thread-board-fixture")
const { SENTINELS } = require("../audit-fixture-data")

const shown = async id => $("~" + id).isDisplayed()
async function tap(id) { const el = await $("~" + id); await el.waitForDisplayed(); await el.click() }
async function swipe(direction, id) {
  const rect = id ? await browser.getElementRect((await $("~" + id)).elementId) : { x: 0, y: 100, ...(await browser.getWindowSize()) }
  const x = Math.round(rect.x + rect.width / 2)
  const a = Math.round(rect.y + rect.height * (direction === "up" ? 0.75 : 0.25))
  const b = Math.round(rect.y + rect.height * (direction === "up" ? 0.25 : 0.75))
  await browser.performActions([{ type: "pointer", id: "audit-finger", parameters: { pointerType: "touch" }, actions: [
    { type: "pointerMove", duration: 0, x, y: a }, { type: "pointerDown", button: 0 },
    { type: "pointerMove", duration: 600, x, y: b }, { type: "pointerUp", button: 0 },
  ] }])
  await browser.releaseActions()
}
async function reveal(id, direction = "up", list) {
  for (let n = 0; n < 8; n++) {
    if (await shown(id)) return
    await swipe(direction, list)
  }
  assert.fail(`Could not reveal ${id} after eight bounded native swipes`)
}
async function noSentinels(fixture) {
  const source = await browser.getPageSource()
  const responses = JSON.stringify(fixture.audit.responses)
  for (const sentinel of SENTINELS) {
    assert(!source.includes(sentinel), "Private error/comment data must not appear in native accessibility output")
    assert(!responses.includes(sentinel), "Display DTO fixture must contain only safe fields")
  }
}

// This spec never touches production credentials or endpoints. It uses the same
// local native build/WDA runner as the board suite, with an audit-only fixture.
describe("Native audit log — isolated display-v1 API", () => {
  let fixture
  const auditRequests = () => fixture.requests.filter(r => r.route === "GET /api/org/audit")
  async function openAudit() { await tap("org-audit"); await $("~audit-list").waitForDisplayed() }
  async function filter(value) {
    await reveal("audit-result-filter", "down", "audit-list")
    await tap("audit-result-filter")
    await tap(`audit-filter-${value}`)
    await browser.waitUntil(() => auditRequests().some(r => new URLSearchParams(r.search).get("result") === value))
  }
  before(async () => {
    assert.equal(process.env.E2E_BUNDLE_ID, "com.suhai.agents.e2e", "Use run-ios.sh, never a production install")
    fixture = await startFixture({ audit: true })
    await browser.waitUntil(async () => await shown("server-url") || await shown("login-username") || await shown("chats-list"), { timeout: 30000 })
    if (await shown("server-url")) {
      await $("~server-url").setValue(fixture.url)
      await tap("server-connect")
      await browser.waitUntil(async () => await shown("login-username") || await shown("chats-list"))
    }
    if (await shown("login-username")) {
      await $("~login-username").setValue("fixture")
      await $("~login-password").setValue("fixture")
      await tap("login-submit")
    }
    await $("~chats-list").waitForDisplayed()
    await $('-ios predicate string:label == "Profile"').click()
    await reveal("open-org")
    await tap("open-org")
    await reveal("org-audit")
    assert.equal(auditRequests().length, 0, "Company must not fetch the removed inline audit dump")
  })
  afterEach(async function () {
    if (!fixture) return
    await noSentinels(fixture)
    // Leave every case at Company so subsequent cases load a fresh audit window.
    // No best-effort pass: a broken native back stack fails the case.
    for (let i = 0; i < 4 && !(await shown("org-audit")); i++) await browser.back()
    await $("~org-audit").waitForDisplayed()
    fixture.audit.cardStatus = 200
    fixture.audit.failNext = null
  })
  after(async () => {
    if (!fixture) return
    await fixture.close()
    assert.deepEqual(fixture.forbidden, [], "Audit viewing cannot mutate cards, approvals, defaults or chats")
    for (const request of auditRequests()) {
      assert.equal(new URLSearchParams(request.search).get("view"), "display-v1", "Never fall back to raw audit")
    }
  })

  it("navigates Profile → Company → Audit, handles initial failure and retries safely", async () => {
    fixture.audit.failNext = 503
    await tap("org-audit")
    await $("~audit-error").waitForDisplayed()
    await noSentinels(fixture)
    await tap("audit-retry")
    await $("~audit-row-309").waitForDisplayed()
    assert.equal(fixture.audit.responses.length, 1)
  })

  it("opens recorded details and the authorized card, then returns to the same list", async () => {
    await openAudit()
    await tap("audit-row-309")
    await $("~audit-entry").waitForDisplayed()
    const source = await browser.getPageSource()
    assert(source.includes("Handler returned"))
    assert(source.includes("does not establish"), "A handler return must not imply successful work")
    await reveal("audit-entry-card")
    await tap("audit-entry-card")
    await $("~card-detail-col-102").waitForDisplayed()
    await browser.back()
    await $("~audit-entry").waitForDisplayed()
    await browser.back()
    await $("~audit-row-309").waitForDisplayed()
  })

  it("filters on the server, retains that filter across detail/back, then resets", async () => {
    await openAudit()
    await filter("queued")
    await $("~audit-row-308").waitForDisplayed()
    assert.equal(await $("~audit-row-309").isExisting(), false)
    await tap("audit-row-308")
    await $("~audit-entry").waitForDisplayed()
    assert((await browser.getPageSource()).includes("does not mean it is still pending"))
    await browser.back()
    await $("~audit-filter-reset").waitForDisplayed()
    await tap("audit-filter-reset")
    await $("~audit-row-309").waitForDisplayed()
    assert.equal(new URLSearchParams(auditRequests().at(-1).search).get("result"), "all")
  })

  it("retains rows on older-page failure, retries the cursor, and reaches exact end", async () => {
    await openAudit()
    await reveal("audit-load-older", "up", "audit-list")
    fixture.audit.failNext = "network"
    await tap("audit-load-older")
    await $("~audit-older-error").waitForDisplayed()
    await reveal("audit-row-309", "down", "audit-list")
    await reveal("audit-load-older", "up", "audit-list")
    await tap("audit-load-older")
    await reveal("audit-row-306", "up", "audit-list")
    await reveal("audit-row-305", "up", "audit-list")
    await tap("audit-row-305")
    await $("~audit-entry").waitForDisplayed()
    assert.equal(await $("~audit-entry-card").isExisting(), false, "Unknown target must not become an invented link")
    await browser.back()
    await reveal("audit-load-older", "up", "audit-list")
    await tap("audit-load-older")
    await reveal("audit-row-301", "up", "audit-list")
    assert.equal(await $("~audit-load-older").isExisting(), false)
    const cursors = auditRequests().map(r => new URLSearchParams(r.search).get("before")).filter(Boolean)
    assert.deepEqual(cursors, ["307", "307", "304"], "Retry same cursor; no timestamp/offset paging")
  })

  it("renders safe missing/inaccessible/null card states without leaking error payloads", async () => {
    for (const status of [403, 404, "null"]) {
      await openAudit()
      await tap("audit-row-309")
      await reveal("audit-entry-card")
      fixture.audit.cardStatus = status
      await tap("audit-entry-card")
      await $("~card-detail-unavailable").waitForDisplayed()
      await noSentinels(fixture)
      await browser.back()
      await browser.back()
      await browser.back()
      await $("~org-audit").waitForDisplayed()
    }
  })

  it("recovers a card network failure using its read-only retry", async () => {
    await openAudit()
    await tap("audit-row-309")
    await reveal("audit-entry-card")
    fixture.audit.cardStatus = "network"
    await tap("audit-entry-card")
    await $("~card-detail-unavailable").waitForDisplayed()
    fixture.audit.cardStatus = 200
    await tap("card-detail-retry")
    await $("~card-detail-col-102").waitForDisplayed()
  })

  it("keeps current rows on failed pull-to-refresh, then recovers explicitly", async () => {
    await openAudit()
    await $("~audit-row-309").waitForDisplayed()
    fixture.audit.failNext = 503
    await swipe("down", "audit-list")
    await $("~audit-refresh-retry").waitForDisplayed()
    await $("~audit-row-309").waitForDisplayed()
    await noSentinels(fixture)
    await tap("audit-refresh-retry")
    await $("~audit-refresh-retry").waitForDisplayed({ reverse: true })
    await $("~audit-row-309").waitForDisplayed()
  })

  it("distinguishes filtered empty history and safely returns to All", async () => {
    const rows = fixture.audit.rows
    try {
      fixture.audit.rows = rows.filter(row => row.result.category !== "denied")
      await openAudit()
      await filter("denied")
      await $("~audit-empty").waitForDisplayed()
      await tap("audit-filter-reset")
      await $("~audit-row-309").waitForDisplayed()
    } finally { fixture.audit.rows = rows }
  })
})
