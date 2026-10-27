const assert = require("node:assert/strict")
const { startFixture, SESSION } = require("../thread-board-fixture")

// A long markdown reply (bold lead-ins, nested bullets, a closing paragraph)
// must stay inside its bubble: the footer (read-aloud + time) sits below the
// last line of text, never on top of it.
const REPLY = [
  "The viewer restarted cleanly at 10:43 and this session picked up where it left off.",
  "",
  "- **Restart check:** before restarting, I ran the new code on a spare port and it loaded with no errors. No scheduled jobs were mid-run, and this was the only agent session running, so nothing was cut off. After the restart there's exactly one server on port 8091, answering normally (401 until you log in). The new notes graph and export routes are live, and there are no errors in the server log. The only entries are harmless \"client disconnected\" lines from connections the restart cut.",
  "- **Card 122** (\"Mobile app: side menu, thread-style Inbox, Calendar, Integrations page, tools and skills marketplace\"): you approved it, so I moved it to Done with a closing comment. One follow-up stays open separately: Calendar and Gmail stay empty until their APIs are switched on in Google Cloud.",
  "- **Card 123** (\"Linked notes, Obsidian-style, plus the relay you switch on from Pair a phone\"): the server part now works too. Graph, export to Obsidian, link updates when you rename a note, and the relay switch all work on web and on build 1791306740. The card is in Review, waiting for you to test it and approve or decline. BUBBLE_END",
].join("\n")

const box = async el => ({ ...(await el.getLocation()), ...(await el.getSize()) })

describe("Agent bubble fits its markdown", function () {
  this.timeout(180000)
  let fixture
  before(async () => {
    fixture = await startFixture({ reply: REPLY })
    await browser.waitUntil(async () => (await $("~server-url").isDisplayed()) || (await $("~login-username").isDisplayed()) || (await $("~chats-list").isDisplayed()), { timeout: 30000 })
    if (await $("~server-url").isDisplayed()) { await $("~server-url").setValue(fixture.url); await $("~server-connect").click(); await browser.waitUntil(async () => (await $("~login-username").isDisplayed()) || (await $("~chats-list").isDisplayed())) }
    if (await $("~login-username").isDisplayed()) { await $("~login-username").setValue("fixture"); await $("~login-password").setValue("fixture"); await $("~login-submit").click() }
    await $(`~chat-${SESSION}`).waitForDisplayed(); await $(`~chat-${SESSION}`).click()
    await $("~thread-viewport").waitForDisplayed()
  })
  after(async () => { await fixture?.close() })

  it("keeps the last line inside the bubble, above the footer", async () => {
    await browser.pause(1500)
    // StaticText only: a container's aggregated label also contains the marker.
    const last = await $('-ios predicate string:type == "XCUIElementTypeStaticText" AND label CONTAINS "BUBBLE_END"')
    await last.waitForExist({ timeout: 15000 })
    const text = await box(last)
    const bubbles = await $$("~agent-bubble").map(async el => box(el))
    const bubble = bubbles.sort((a, b) => b.y - a.y)[0]   // the newest is lowest on screen
    const foot = (await $$("~read-aloud").map(async el => box(el))).sort((a, b) => b.y - a.y)[0]
    console.log("TEXT", JSON.stringify(text), "BUBBLE", JSON.stringify(bubble), "FOOT", JSON.stringify(foot))
    assert.ok(text.y + text.height <= bubble.y + bubble.height, `text bottom ${text.y + text.height} spills past bubble bottom ${bubble.y + bubble.height}`)
    assert.ok(text.y + text.height <= foot.y + 2, `text bottom ${text.y + text.height} overlaps footer top ${foot.y}`)
  })
})
