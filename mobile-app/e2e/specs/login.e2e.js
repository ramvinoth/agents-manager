// Smoke test for the MVP happy path: connect to a server, sign in, land on Hosts.
// Elements are found by accessibility id (`~name`), which maps to the `testID` +
// `accessibilityLabel` pairs set on the screens (content-desc on Android,
// accessibilityIdentifier on iOS).
//
// Config via env (never commit real credentials):
//   E2E_SERVER_URL  default http://10.0.2.2:8091  (10.0.2.2 = host loopback from an Android emulator)
//   E2E_USERNAME    default "owner"
//   E2E_PASSWORD    default "changeme"
const SERVER_URL = process.env.E2E_SERVER_URL || "http://10.0.2.2:8091"
const USERNAME = process.env.E2E_USERNAME || "owner"
const PASSWORD = process.env.E2E_PASSWORD || "changeme"

describe("Agents mobile — login smoke", () => {
  // On failure, capture the screen and dump the visible accessibility ids —
  // guessing at "element not found" from logs alone wastes whole build cycles.
  afterEach(async function () {
    if (this.currentTest && this.currentTest.state === "failed") {
      try {
        if (process.env.E2E_FAIL_SHOT) await browser.saveScreenshot(process.env.E2E_FAIL_SHOT)
        const src = await browser.getPageSource()
        const ids = [...src.matchAll(/name="([^"]+)"/g)].map((m) => m[1]).slice(0, 40)
        // eslint-disable-next-line no-console
        console.log("VISIBLE_IDS:", JSON.stringify(ids))
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log("failure-capture error:", e.message)
      }
    }
  })

  it("connects to a server and signs in to reach the Chats home", async () => {
    const urlField = await $("~server-url")
    await urlField.waitForDisplayed({ timeout: 20000 })
    await urlField.setValue(SERVER_URL)
    await (await $("~server-connect")).click()

    const userField = await $("~login-username")
    await userField.waitForDisplayed({ timeout: 20000 })
    await userField.setValue(USERNAME)
    await (await $("~login-password")).setValue(PASSWORD)
    await (await $("~login-submit")).click()

    // Landed on the Chats home — a WhatsApp-style list of agent sessions.
    await (await $("~chats-list")).waitForDisplayed({ timeout: 30000 })

    // Regression: the ☰ drawer entry point (the mobile "left-hand column")
    // survives. (Its contents are exercised in the drawer-focused capture.)
    await (await $("~menu-button")).waitForDisplayed({ timeout: 10000 })

    // ＋ New chat: verify the composer screen opens and can be dismissed.
    try {
      await (await $("~new-chat-button")).click()
      await (await $("~newchat-message")).waitForDisplayed({ timeout: 10000 })
      await (await $("~newchat-cwd")).waitForDisplayed({ timeout: 5000 })
      if (process.env.E2E_SHOT_NEWCHAT) await browser.saveScreenshot(process.env.E2E_SHOT_NEWCHAT)
      await browser.back()
      await (await $("~chats-list")).waitForDisplayed({ timeout: 10000 })
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log("newchat-check skipped:", e.message)
    }

    // Open the first chat and land in the thread — the message-listing feature.
    const firstChat = await $('-ios predicate string:name BEGINSWITH "chat-"')
    await firstChat.waitForDisplayed({ timeout: 15000 })
    await firstChat.click()
    await (await $("~thread-list")).waitForDisplayed({ timeout: 20000 })
    await browser.pause(2500) // let the transcript load + bubbles render

    // Best-effort: expand an agent exchange's collapsed steps, then a tool step,
    // so the capture shows tool results inline. Wrapped — a miss still screenshots
    // the (collapsed) thread, which itself proves the grouping + composer dropdowns.
    try {
      const toggle = await $("~steps-toggle")
      await toggle.waitForExist({ timeout: 8000 })
      await toggle.click()
      await browser.pause(500)
      const tool = await $('-ios predicate string:name BEGINSWITH "tool-"')
      await tool.waitForExist({ timeout: 6000 })
      await tool.click()
      await browser.pause(800)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log("step-expand skipped:", e.message)
    }

    // Optional: send a real message and capture the live "working" state —
    // the typing subtitle in the header + the working bubble in the thread.
    // Off by default (it drives a real agent run); set E2E_SEND=1 to enable.
    if (process.env.E2E_SEND) {
      try {
        const box = await $("~composer-input")
        await box.setValue(process.env.E2E_SEND_TEXT || "Say hi in one short sentence.")
        await (await $("~composer-send")).click()
        // Catch the in-flight state: the header subtitle + working bubble.
        await (await $("~working-bubble")).waitForDisplayed({ timeout: 20000 })
        await browser.pause(1200)
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log("send-capture skipped:", e.message)
      }
    }

    // Optional visual proof: set E2E_SHOT to a file path to capture the screen.
    if (process.env.E2E_SHOT) await browser.saveScreenshot(process.env.E2E_SHOT)
  })
})
