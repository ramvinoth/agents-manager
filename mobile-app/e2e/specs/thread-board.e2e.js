const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { startFixture, SESSION, BOARD_SESSION_B } = require("../thread-board-fixture")

// Native W3C pointer actions, not JS callbacks or an alternate renderer.
async function drag(points) {
  await browser.performActions([{ type: "pointer", id: "finger", parameters: { pointerType: "touch" }, actions: [
    { type: "pointerMove", duration: 0, x: Math.round(points[0][0]), y: Math.round(points[0][1]) },
    { type: "pointerDown", button: 0 },
    ...points.slice(1).map(([x, y]) => ({ type: "pointerMove", duration: 220, x: Math.round(x), y: Math.round(y) })),
    { type: "pointerUp", button: 0 },
  ] }])
  await browser.releaseActions()
}
async function rect(id) { return browser.getElementRect((await $(id)).elementId) }
async function edgeSwipe(distance = 150) {
  const r = await rect("~thread-viewport")
  await drag([[r.x + r.width - 8, r.y + r.height * 0.5], [r.x + r.width - 8 - distance, r.y + r.height * 0.5]])
}
async function threadVisible() { await $("~thread-viewport").waitForDisplayed(); assert.equal(await $("~kanban-board").isDisplayed(), false) }
async function backToThread() { await browser.back(); await threadVisible() }

describe("Native thread board gesture — isolated API", () => {
  let fixture
  async function assertBoard(session, checkpoint) {
    const own = session === SESSION ? [201, 202] : [211, 212]
    const other = session === SESSION ? [211, 212] : [201, 202]
    await $("~kanban-board").waitForDisplayed()
    for (const id of own) await $(`~kanban-card-${id}`).waitForDisplayed()
    for (const id of other) assert.equal(await $(`~kanban-card-${id}`).isExisting(), false, "Other chat's cards must be absent")
    const reads = fixture.requests.slice(checkpoint).filter(r => ["GET /api/org/board", "GET /api/org/cards"].includes(r.route))
    for (const endpoint of ["board", "cards"]) {
      const matches = reads.filter(r => r.route === `GET /api/org/${endpoint}`)
      assert(matches.length > 0, `Opening must request ${endpoint}`)
      assert(matches.every(r => new URLSearchParams(r.search).get("session") === session), `Every new ${endpoint} request must belong to ${session}`)
    }
  }
  before(async () => {
    assert.equal(process.env.E2E_BUNDLE_ID, "com.suhai.agents.e2e", "Use run-ios.sh's isolated app, never a production install")
    fixture = await startFixture({ boardIsolation: true, boardMutations: true })
    await browser.waitUntil(async () => (await $("~server-url").isDisplayed()) || (await $("~login-username").isDisplayed()) || (await $("~chats-list").isDisplayed()), { timeout: 30000 })
    if (await $("~server-url").isDisplayed()) {
      await $("~server-url").setValue(fixture.url)
      await $("~server-connect").click()
      await browser.waitUntil(async () => (await $("~login-username").isDisplayed()) || (await $("~chats-list").isDisplayed()))
    }
    if (await $("~login-username").isDisplayed()) {
      await $("~login-username").setValue("fixture")
      await $("~login-password").setValue("fixture")
      await $("~login-submit").click()
    }
    await $(`~chat-${SESSION}`).waitForDisplayed()
    await $(`~chat-${SESSION}`).click()
    await $("~thread-viewport").waitForDisplayed()
    // autoAcceptAlerts has now dismissed the notification-permission prompt that opening a thread
    // triggers. From here alerts must be left alone: the thread ⋯ menu is a native alert and the
    // tests tap its "Board" button. At runtime WDA only honours defaultAlertAction ("" = no auto action).
    await browser.updateSettings({ defaultAlertAction: "" })
  })
  after(async () => {
    if (fixture) {
      await fixture.close()
      assert.deepEqual(fixture.forbidden, [], "No chat, card mutation or other unsupported write may be attempted")
    }
  })
  afterEach(async function () {
    if (this.currentTest.state !== "failed") return
    console.log("NATIVE_PAGE_SOURCE", await browser.getPageSource())
    // Every test starts and ends on the thread. Restore that after a failure so
    // one broken scenario does not cascade into the rest.
    for (let i = 0; i < 3 && !(await $("~thread-viewport").isDisplayed()); i++) await browser.back()
  })

  it("opens this session's real board from the right transcript edge, repeatedly", async () => {
    for (let i = 0; i < 2; i++) {
      const checkpoint = fixture.requests.length
      await edgeSwipe()
      await assertBoard(SESSION, checkpoint)
      await backToThread()
    }
  })

  it("retains the accessible Board menu and real user/agent card detail move chips", async () => {
    await $("~thread-more").click()
    await $("~Board").click()
    await $("~kanban-board").waitForDisplayed()
    for (const id of [201, 202]) {
      await $(`~kanban-card-${id}`).click()
      await $("~card-detail-col-102").waitForDisplayed()
      await $("~card-detail-col-103").waitForDisplayed()
      await browser.back()
    }
    await backToThread()
  })

  it("isolates A → B → A across menu, gesture and chat-list board entry", async () => {
    await browser.back()
    await $("~chats-list").waitForDisplayed()
    for (const method of ["menu", "gesture", "row"]) {
      for (const session of [SESSION, BOARD_SESSION_B, SESSION]) {
        const checkpoint = fixture.requests.length
        if (method === "row") {
          await $(`~chat-board-${session}`).click()
        } else {
          await $(`~chat-${session}`).click()
          await $("~thread-viewport").waitForDisplayed()
          if (method === "gesture") await edgeSwipe()
          else { await $("~thread-more").click(); await $("~Board").click() }
        }
        await assertBoard(session, checkpoint)
        const card = session === SESSION ? 201 : 211
        await $(`~kanban-card-${card}`).click()
        await $("~card-detail-col-102").waitForDisplayed()
        const details = fixture.requests.slice(checkpoint).filter(r => r.route === "GET /api/org/card")
        assert(details.length > 0 && details.every(r => new URLSearchParams(r.search).get("id") === String(card)))
        await browser.back()
        await browser.back()
        if (method !== "row") { await threadVisible(); await browser.back() }
        await $("~chats-list").waitForDisplayed()
      }
    }
    await $(`~chat-${SESSION}`).click()
    await threadVisible()
  }).timeout(420000) // nine board round trips at ~20s each on the simulator; wdio reads the timeout before the body runs

  it("does not publish a delayed A response after opening B", async () => {
    const held = fixture.board.holdNext("cards", SESSION)
    try {
      await edgeSwipe()
      await browser.waitUntil(() => fixture.requests.some(r => r.route === "GET /api/org/cards" && new URLSearchParams(r.search).get("session") === SESSION) && held.claimed)
      await browser.back()
      await threadVisible()
      await browser.back()
      await $("~chats-list").waitForDisplayed()
      await $(`~chat-${BOARD_SESSION_B}`).click()
      await threadVisible()
      const checkpoint = fixture.requests.length
      await $("~thread-more").click()
      await $("~Board").click()
      await assertBoard(BOARD_SESSION_B, checkpoint)
      held.release()
      // A's completion is followed by an observable B poll, not an arbitrary sleep.
      const afterRelease = fixture.requests.length
      await browser.waitUntil(() => fixture.requests.slice(afterRelease).some(r => r.route === "GET /api/org/cards" && new URLSearchParams(r.search).get("session") === BOARD_SESSION_B), { timeout: 10000 })
      await assertBoard(BOARD_SESSION_B, checkpoint)
      await browser.back()
      await browser.back()
      await $("~chats-list").waitForDisplayed()
      await $(`~chat-${SESSION}`).click()
      await threadVisible()
    } finally { held.release() }
  })

  it("rejects a short edge swipe and reversed completion", async () => {
    await edgeSwipe(30)
    await threadVisible()
    const r = await rect("~thread-viewport")
    const x = r.x + r.width - 8, y = r.y + r.height * 0.5
    await drag([[x, y], [x - 90, y], [x - 10, y]])
    await threadVisible()
  })

  it("rejects a two-finger board swipe", async () => {
    const r = await rect("~thread-viewport")
    await browser.performActions([0, 1].map(i => ({
      type: "pointer", id: `multi-${i}`, parameters: { pointerType: "touch" }, actions: [
        { type: "pointerMove", duration: 0, x: Math.round(r.x + r.width - 8), y: Math.round(r.y + r.height * 0.5 + i * 45) },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", duration: 450, x: Math.round(r.x + r.width - 160), y: Math.round(r.y + r.height * 0.5 + i * 45) },
        { type: "pointerUp", button: 0 },
      ],
    })))
    await browser.releaseActions()
    await threadVisible()
  })

  it("preserves rightward message swipe-to-reply", async () => {
    const reply = await $('-ios predicate string:label == "Native reply target"')
    await reply.waitForDisplayed()
    const r = await browser.getElementRect(reply.elementId)
    await drag([[r.x + 8, r.y + r.height / 2], [r.x + 115, r.y + r.height / 2]])
    await $("~reply-cancel").waitForDisplayed()
    // The quote must contain this message, not a stale previous selection.
    const copies = await $$('-ios predicate string:type == "XCUIElementTypeStaticText" AND label == "Native reply target"')
    assert.equal(copies.length, 2, "Original bubble and composer quote must both contain the selected message")
    await $("~reply-cancel").click()
    await threadVisible()
  })

  it("allows vertical transcript scrolling without navigating", async () => {
    const r = await rect("~thread-viewport")
    await drag([[r.x + r.width / 2, r.y + 50], [r.x + r.width / 2, r.y + r.height - 60]])
    await $("~jump-to-latest").waitForDisplayed()
    await threadVisible()
    await $("~jump-to-latest").click()
  })

  it("does not intercept nested code/table horizontal drags", async () => {
    for (const marker of ["CODE_START", "TABLE_START"]) {
      const text = await $(`-ios predicate string:type == "XCUIElementTypeStaticText" AND label BEGINSWITH "${marker}"`)
      await text.waitForDisplayed()
      const r = await browser.getElementRect(text.elementId)
      const viewport = await rect("~thread-viewport")
      // Start within the actual nested scroll view, not the board's edge strip.
      const x = Math.min(r.x + 180, viewport.x + viewport.width - 45)
      await drag([[x, r.y + r.height / 2], [r.x + 8, r.y + r.height / 2]])
      await threadVisible()
      const after = await browser.getElementRect(text.elementId)
      assert(after.x < r.x, `${marker} must visibly scroll, not merely avoid board navigation`)
    }
  })

  it("keeps edge bounds correct with the keyboard visible", async () => {
    await $("~composer-input").click()
    await edgeSwipe()
    await $("~kanban-board").waitForDisplayed()
    await backToThread()
  })

  // Keep mutations after the read-only isolation scenarios: new cards must not
  // change their initial board layout or their fixed A/B expectations.
  it("creates a human card inline, moves it, and reloads the persisted destination", async () => {
    await edgeSwipe()
    await createAndMove("Native human inline create", 102)
    await backToThread()
  })

  // The inline create above raised the keyboard while the board covered the
  // thread; the thread relaid out underneath with no window. The edge swipe must
  // still work on the very next touch, without a further layout pass.
  it("moves an existing agent card and reloads the persisted destination", async () => {
    await edgeSwipe()
    await moveAndReopen(202, 102)
    await backToThread()
  })

  it("locates move controls below a newly created long human title and persists its move", async () => {
    await edgeSwipe()
    // Inline creation has ONE single-line title field, not a body editor: a
    // typed newline is the return key and submits the card early. Type one long
    // paragraph, as users do; do not inject a body through a backdoor fixture write.
    const title = Array.from({ length: 8 }, (_, i) =>
      `Request paragraph ${i + 1}: Please investigate the task board carefully, verify the actual installed application, and report what is visible before changing anything. Keep the server authoritative and preserve every requirement in this request.`
    ).join(" ")
    await createAndMove(title, 102, true)
    await backToThread()
  })

  async function createAndMove(title, columnId, inspectViewport = false) {
    const checkpoint = fixture.requests.length
    await $("~kanban-add-101").click()
    await $("~kanban-new-card").setValue(title)
    // Tap the column heading to blur the actual native input and submit through
    // KanbanScreen.onBlur (no direct API creation or JS callback invocation).
    await $('-ios predicate string:type == "XCUIElementTypeStaticText" AND label BEGINSWITH "To Do"').click()
    await browser.waitUntil(() => fixture.requests.slice(checkpoint).some(r => r.route === "POST /api/org/cards" && r.response))
    const creations = fixture.requests.slice(checkpoint).filter(r => r.route === "POST /api/org/cards")
    assert.equal(creations.length, 1, "Native input must create exactly once")
    const creation = creations[0]
    assert.deepEqual(creation.body, { title, column_id: 101, session: SESSION })
    assert.equal(creation.response.project_id, 1)
    assert.equal(creation.response.created_by, "user:fixture")
    await moveAndReopen(creation.response.id, columnId, inspectViewport)
    assert.equal(fixture.requests.slice(checkpoint).filter(r => r.route === "POST /api/org/cards").length, 1)
  }

  async function revealMove(columnId, inspectViewport = false) {
    await $("~card-detail-comment").waitForDisplayed()
    const selector = `~card-detail-col-${columnId}`
    const viewport = await browser.getWindowRect()
    async function observation() {
      const element = await $(selector)
      const exists = await element.isExisting()
      const displayed = exists && await element.isDisplayed()
      const bounds = exists ? await browser.getElementRect(element.elementId) : null
      return { exists, displayed, bounds, viewport,
        inViewport: !!(displayed && bounds && bounds.y >= viewport.y && bounds.y + bounds.height <= viewport.y + viewport.height) }
    }
    const initial = await observation()
    if (inspectViewport) {
      console.log("LONG_CARD_INITIAL_MOVE_VIEWPORT", JSON.stringify(initial))
      const screenshot = process.env.E2E_SHOT_LONG_CARD || path.resolve(__dirname, "../.artifacts/card-long-initial.png")
      fs.mkdirSync(path.dirname(screenshot), { recursive: true })
      await browser.saveScreenshot(screenshot)
      console.log("LONG_CARD_INITIAL_SCREENSHOT", screenshot)
    }
    let current = initial
    for (let swipe = 0; !current.inViewport && swipe < 16; swipe++) {
      await drag([[viewport.width * 0.5, viewport.height * 0.72], [viewport.width * 0.5, viewport.height * 0.3]])
      current = await observation()
    }
    if (inspectViewport) console.log("LONG_CARD_REVEALED_MOVE_VIEWPORT", JSON.stringify(current))
    assert(current.inViewport, `Move control remains absent/offscreen after bounded native scrolling: ${JSON.stringify(current)}`)
  }

  async function showBoardCard(id) {
    const viewport = await browser.getWindowRect()
    for (let swipe = 0; swipe < 4; swipe++) {
      const card = await $(`~kanban-card-${id}`)
      if (await card.isExisting()) {
        const bounds = await browser.getElementRect(card.elementId)
        const boardBounds = await rect("~kanban-board")
        const top = Math.max(bounds.y, boardBounds.y), bottom = Math.min(bounds.y + bounds.height, boardBounds.y + boardBounds.height, viewport.height)
        const left = Math.max(bounds.x, boardBounds.x, 0), right = Math.min(bounds.x + bounds.width, boardBounds.x + boardBounds.width, viewport.width)
        if (await card.isDisplayed() && right - left >= 40 && bottom - top >= 12) {
          // A card can extend beyond the viewport in either axis (long title, or a
          // column straddling the edge after a horizontal fling); native
          // element.click() would tap its offscreen center. Tap the observed
          // visible region instead.
          return { x: (left + right) / 2, y: top + Math.min(20, (bottom - top) / 2) }
        }
      }
      // Start in column whitespace below the cards, not on a draggable card.
      await drag([[viewport.width * 0.85, viewport.height * 0.78], [viewport.width * 0.15, viewport.height * 0.78]])
    }
    assert.fail(`Card ${id} has no safe visible native tap point after bounded board scrolling`)
  }

  async function tapBoardCard(id) {
    const { x, y } = await showBoardCard(id)
    await drag([[x, y]])
  }

  async function moveAndReopen(id, columnId, inspectViewport = false) {
    const opened = fixture.requests.length
    await tapBoardCard(id)
    await browser.waitUntil(() => fixture.requests.slice(opened).some(r => r.route === "GET /api/org/card" && new URLSearchParams(r.search).get("id") === String(id)))
    await $("~card-detail-delete").waitForExist()
    await revealMove(columnId, inspectViewport)
    const checkpoint = fixture.requests.length
    await $(`~card-detail-col-${columnId}`).click()
    await browser.waitUntil(() => fixture.requests.slice(checkpoint).some(r => r.route === "POST /api/org/cards/move" && r.response))
    const moves = fixture.requests.slice(checkpoint).filter(r => r.route === "POST /api/org/cards/move")
    assert.equal(moves.length, 1)
    assert.deepEqual(moves[0].body, { card_id: id, column_id: columnId, position: 9999 })
    await browser.back()
    await $("~kanban-board").waitForDisplayed()
    const returned = fixture.requests.length
    await browser.waitUntil(() => fixture.requests.slice(returned).some(r =>
      r.route === "GET /api/org/cards" && r.response?.cards.some(c => c.id === id && c.column_id === columnId)), { timeout: 10000 })
    const reopened = fixture.requests.length
    await tapBoardCard(id)
    await browser.waitUntil(() => fixture.requests.slice(reopened).some(r => r.route === "GET /api/org/card" && r.response?.card.id === id))
    const reads = fixture.requests.slice(reopened).filter(r => r.route === "GET /api/org/card" && r.response?.card.id === id)
    assert(reads.length > 0)
    assert(reads.every(r => r.response.card.column_id === columnId), "Reopened native detail must receive the persisted destination")
    await revealMove(columnId)
    await browser.back()
    await $("~kanban-board").waitForDisplayed()
  }

  // WDA 11.1.5 preprocesses pointerCancel by deleting the preceding action,
  // rather than dispatching UIKit touchesCancelled. Do not report that as native
  // PanResponder termination coverage (predicate/unit coverage is separate).
  it.skip("rejects an OS-cancelled in-flight swipe (WDA cannot synthesize touchesCancelled)", () => {})

  it("preserves portrait layout after a device rotation attempt", async () => {
    // The app declares portrait-only orientations, so XCUITest refuses the
    // rotation ("Unable To Rotate Device"). That refusal is the expected outcome;
    // what must hold afterwards is that the app is still portrait and usable.
    await browser.setOrientation("LANDSCAPE").catch(() => {})
    assert.equal(await browser.getOrientation(), "PORTRAIT")
    await threadVisible()
    await edgeSwipe()
    await $("~kanban-board").waitForDisplayed()
    await backToThread()
  })

  it("preserves native left-edge back", async () => {
    const r = await rect("~thread-viewport")
    await drag([[2, r.y + r.height * 0.5], [r.width * 0.8, r.y + r.height * 0.5]])
    await $("~chats-list").waitForDisplayed()
  })
})
