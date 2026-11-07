// One sign-in for every spec: server address (if asked), then fixture credentials (if asked).
// The simulator keyboard can drop or repeat keystrokes under load ("hp://..."), and the
// fields' accessibility labels hide their values, so typing is checked by its outcome:
// if the next screen does not appear, the field is emptied and typed again.
const shown = id => $("~" + id).isDisplayed()
const KEYBOARD = "-ios class chain:**/XCUIElementTypeKeyboard"

async function type(id, text) {
  const el = await $("~" + id)
  await el.click()
  await $(KEYBOARD).waitForDisplayed({ timeout: 10000 })
  await el.addValue("\b".repeat(80)) // clearValue can't empty a controlled RN input
  await el.addValue(text)
}

async function attempt(fill, submit, done) {
  for (let i = 0; i < 3; i++) {
    await fill()
    await $("~" + submit).click()
    if (await browser.waitUntil(done, { timeout: 15000 }).catch(() => false)) return
  }
  throw new Error(`sign-in: ${submit} did not reach the next screen after 3 tries`)
}

async function signIn(fixture) {
  await browser.waitUntil(async () => await shown("server-url") || await shown("login-username") || await shown("chats-list"), { timeout: 30000 })
  if (await shown("server-url")) {
    await attempt(() => type("server-url", fixture.url), "server-connect",
      async () => await shown("login-username") || await shown("chats-list"))
  }
  if (await shown("login-username")) {
    await attempt(async () => { await type("login-username", "fixture"); await type("login-password", "fixture") },
      "login-submit", () => shown("chats-list"))
  }
}

module.exports = { signIn }
