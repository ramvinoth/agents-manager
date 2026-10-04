const assert = require("node:assert/strict")
const { startFixture, SESSION } = require("../thread-board-fixture")

// Six swipeable tabs share ONE parent-stack header. Each tab must leave exactly
// its own header controls after every transition — never a sibling's lingering
// or appended. Checks every ordered pair of tabs, by tap and by swipe.
const TABS = ["Chats", "Inbox", "Files", "Notes", "Agents", "Profile"]
const OWN = {
  Chats: ["new-chat-button", "chats-terminal"],
  Inbox: [],
  Files: ["location-header-button", "files-terminal"],
  Notes: ["notes-add"],
  Agents: [],
  Profile: ["theme-toggle"],
}
const ALL = [...new Set(Object.values(OWN).flat())]

// One native predicate query per assertion for just the header controls — a
// query per control, or a full page-source read (the pager renders all six
// tabs, ~35s each), blew the timeout.
const QUERY = `-ios predicate string:name IN {${ALL.map((id) => `"${id}"`).join(", ")}}`
async function onScreen() { return $$(QUERY).map((el) => el.getAttribute("name")) } // wdio v9: ElementArray.map is already async
async function tab(name) { await $(`~tab-${name}`).click() }
async function assertHeader(name, how) {
  await browser.pause(400) // let the focus effect commit the header
  const seen = await onScreen()
  for (const id of ALL) {
    const want = OWN[name].includes(id) ? 1 : 0
    const got = seen.filter((n) => n === id).length
    assert.equal(got, want, `${how} → ${name}: header control ${id} expected ${want}, found ${got}`)
  }
}

describe("Tab header ownership — every transition", function () {
  this.timeout(600000) // 31 taps + 10 swipes, each with a native query
  let fixture
  before(async () => {
    fixture = await startFixture()
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
  })
  after(async () => { if (fixture) await fixture.close() })

  it("tapping from every tab to every other tab leaves only the target's controls", async () => {
    // One walk that uses every ordered pair (from → to) exactly once — an Euler
    // circuit of the complete directed graph — instead of a round trip per pair:
    // half the header reads, each of which costs a full page-source fetch.
    const left = Object.fromEntries(TABS.map((a) => [a, TABS.filter((b) => b !== a)]))
    const walk = [], stack = [TABS[0]]
    while (stack.length) {
      const at = stack[stack.length - 1]
      if (left[at].length) stack.push(left[at].shift())
      else walk.unshift(stack.pop())
    }
    await tab(walk[0]); await assertHeader(walk[0], "tap")
    for (let i = 1; i < walk.length; i++) { await tab(walk[i]); await assertHeader(walk[i], `tap ${walk[i - 1]}`) }
  })

  it("swiping through the pager both ways leaves only the focused tab's controls", async () => {
    await tab("Chats"); await assertHeader("Chats", "start")
    const { width, height } = await browser.getWindowSize()
    const y = Math.round(height * 0.6)
    const swipe = async (dx) => {
      const [a, b] = dx < 0 ? [width * 0.85, width * 0.15] : [width * 0.15, width * 0.85]
      await browser.performActions([{ type: "pointer", id: "f", parameters: { pointerType: "touch" }, actions: [
        { type: "pointerMove", duration: 0, x: Math.round(a), y }, { type: "pointerDown", button: 0 },
        { type: "pointerMove", duration: 250, x: Math.round(b), y }, { type: "pointerUp", button: 0 },
      ] }])
      await browser.releaseActions()
      await browser.pause(600)
    }
    for (let i = 1; i < TABS.length; i++) { await swipe(-1); await assertHeader(TABS[i], "swipe left") }
    for (let i = TABS.length - 2; i >= 0; i--) { await swipe(1); await assertHeader(TABS[i], "swipe right") }
  })

  it("Files renders its real state, never a raw server error", async () => {
    await $("~tab-Files").click()
    await $("~filestab-list").waitForDisplayed()
    assert.equal(await $("~filestab-error").isExisting(), false, "Files showed an error banner on a healthy server")
  })
})
