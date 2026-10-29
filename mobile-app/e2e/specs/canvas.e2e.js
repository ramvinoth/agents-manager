const assert = require("node:assert/strict")
const { startFixture, SESSION } = require("../thread-board-fixture")

const shown = id => $("~" + id).isDisplayed()
async function tap(id) { const el = await $("~" + id); await el.waitForDisplayed(); await el.click() }

// The canvas page loads from harman://app inside the app's own web view, and
// every request it makes — its document, a GET, a POST with a body — is
// answered by the app's transport with the app's token; its socket is bridged
// back through the app (the fixture refuses the upgrade, so the page must see
// the close). That is what lets the canvas work over the relay too.
describe("Native canvas — the page runs on the app's transport", function () {
  this.timeout(240000)
  let fixture
  const seen = r => fixture.requests.filter(x => x.route === r)

  before(async () => {
    assert.equal(process.env.E2E_BUNDLE_ID, "com.suhai.agents.e2e", "Never run against a production bundle")
    fixture = await startFixture({ canvas: true })
    await browser.waitUntil(async () => await shown("server-url") || await shown("login-username") || await shown("chats-list"), { timeout: 30000 })
    if (await shown("server-url")) {
      await $("~server-url").setValue(fixture.url); await tap("server-connect")
      await browser.waitUntil(async () => await shown("login-username") || await shown("chats-list"))
    }
    if (await shown("login-username")) {
      await $("~login-username").setValue("fixture"); await $("~login-password").setValue("fixture"); await tap("login-submit")
    }
    await $("~chats-list").waitForDisplayed()
    await tap(`chat-${SESSION}`)
    await $("~thread-viewport").waitForDisplayed()
    await tap("thread-more")
    await tap("Canvas")
  })
  after(async () => { await fixture?.close() })

  it("loads the page and answers its requests with the app's token", async () => {
    await $("~canvas-webview").waitForDisplayed({ timeout: 20000 })
    await browser.waitUntil(async () => seen("POST /api/canvas-probe").length > 0, { timeout: 20000, timeoutMsg: "page never posted" })
      .catch(async e => {
        const labels = await $$("-ios predicate string:label BEGINSWITH 'CANVAS' OR label BEGINSWITH 'WS_'").map(el => el.getAttribute("label"))
        throw new Error(`${e.message}; requests: ${fixture.requests.map(x => x.route).join(", ")}; page: ${labels.join(" | ")}`)
      })
    assert.equal(await $("~canvas-error").isExisting(), false, "no error state")
    for (const r of ["GET /", "GET /api/canvas-probe", "POST /api/canvas-probe"]) {
      assert.ok(seen(r).length > 0, `${r} reached the server`)
      assert.ok(seen(r).every(x => x.auth), `${r} carried the Bearer token`)
    }
    assert.deepEqual(seen("POST /api/canvas-probe")[0].body, { ping: "pong" }, "the POST body reached the server")
  })

  it("the page saw both replies and its socket's close", async () => {
    const page = async () => (await $$("-ios predicate string:type == 'XCUIElementTypeStaticText'").map(el => el.getAttribute("label"))).join(" | ")
    for (const want of ["CANVAS_OK", "WS_CLOSED"]) {
      await $(`-ios predicate string:label CONTAINS '${want}'`).waitForExist({ timeout: 15000 })
        .catch(async e => { throw new Error(`${want}: ${e.message}; page: ${await page()}`) })
    }
  })

  // What Excalidraw does with a link nobody handled: window.open(undefined),
  // an empty URL. Build 1791768513 crashed on it (Linking.openURL threw).
  it("a page opening an empty window does not crash the app", async () => {
    await $("-ios predicate string:label == 'OPEN_BLANK'").click()
    await browser.pause(1500)
    assert.equal(await $("~canvas-webview").isDisplayed(), true, "still on the canvas")
  })

  // A tile's harman://card/N link: the page hands it to the app, which opens
  // the card's own screen.
  it("a card link opens the card's screen", async () => {
    await $("-ios predicate string:label == 'OPEN_CARD'").click()
    await $("~card-detail-col-101").waitForDisplayed({ timeout: 15000 })
  })
})
