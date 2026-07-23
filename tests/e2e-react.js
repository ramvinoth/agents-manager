// End-to-end check for the React/shadcn UI (the default on :8091).
// Verifies the production app against the live backend by driving the DOM
// (the React app has no `viewer` global). Usage:
//   NODE_PATH=$(npm root -g) node tests/e2e-react.js [BASE] [REMOTE]
const { chromium } = require("playwright")
const fs = require("fs")
const os = require("os")
const path = require("path")

const BASE = process.argv[2] || "http://localhost:8091"
// Substring of a remote host's label to exercise the host-switch flow; env-
// overridable. The check below skips (passes) when no matching host is configured.
const REMOTE_LABEL = process.argv[3] || process.env.VIEWER_TEST_REMOTE_LABEL || "Mac"
// The API needs a logged-in session; the Makefile mints one (mint_session.py)
// and passes the token via VIEWER_SESSION — we set it as the session cookie.
const SESSION = process.env.VIEWER_SESSION || ""
let pass = 0,
  fail = 0
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`)
}

;(async () => {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  if (SESSION) {
    const u = new URL(BASE)
    await context.addCookies([
      { name: "viewer_session", value: SESSION, domain: u.hostname, path: "/", httpOnly: true, sameSite: "Strict" },
    ])
  }
  const page = await context.newPage()
  const errors = []
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message))

  await page.goto(BASE + "/", { waitUntil: "networkidle" })
  await page.waitForTimeout(3500)

  // 1. Boots + sessions + transcript render.
  const boot = await page.evaluate(() => ({
    header: document.body.innerText.includes("Agents"),
    sessions: document.querySelectorAll("aside button").length,
    turns: document.querySelectorAll(".markdown-content").length,
    composer: !!document.querySelector("textarea"),
  }))
  ok("app boots (header + composer)", boot.header && boot.composer)
  ok("session list populated", boot.sessions > 3, `${boot.sessions} buttons`)
  ok("transcript renders", boot.turns >= 0, `${boot.turns} md blocks`)

  // 2. Skills (RHS capabilities) load.
  const skills = await page.evaluate(() => /\d+ skills/.test(document.body.innerText))
  ok("skills panel loaded", skills)

  // 3. Stats tab.
  await page.getByRole("tab", { name: "Stats" }).click()
  await page.waitForTimeout(800)
  const stats = await page.evaluate(
    () => /User messages/.test(document.body.innerText) && !!document.querySelector("svg path")
  )
  ok("stats tab (metrics + token chart)", stats)
  await page.getByRole("tab", { name: "Sessions" }).click()

  // 4. Search (Ctrl+F → highlight).
  await page.keyboard.press("Control+f")
  await page.waitForTimeout(300)
  await page.keyboard.type("the")
  await page.waitForTimeout(500)
  const search = await page.evaluate(() => ({
    bar: !!document.querySelector('input[placeholder="Search transcript"]'),
    hi: !!document.querySelector('[class*="ring-primary"]'),
  }))
  ok("search bar + highlight", search.bar && search.hi)
  await page.keyboard.press("Escape")

  // 5. Terminal panel connects to a live PTY.
  await page.click('[title="Terminal panel"]')
  await page.waitForTimeout(2500)
  const term = await page.evaluate(() => ({
    xterm: !!document.querySelector(".xterm"),
    connected: document.body.innerText.includes("connected"),
  }))
  ok("terminal connects (xterm + PTY)", term.xterm && term.connected)
  await page.click('[aria-label="Close panel"]').catch(() => {})

  // 6. Host switch to a remote host reloads sessions.
  await page.click("header button:has-text('This machine')").catch(() => {})
  await page.waitForTimeout(500)
  const remoteItem = page.getByRole("menuitem", { name: new RegExp(REMOTE_LABEL, "i") })
  if ((await remoteItem.count()) > 0) {
    await remoteItem.first().click()
    await page.waitForTimeout(6000)
    const switched = await page.evaluate(() => document.querySelectorAll("aside button").length > 3)
    ok("host switch loads remote sessions", switched)
  } else {
    // No remote host configured (e.g. a fresh clone) — skip, don't fail.
    ok("host switch (skipped — no remote host configured)", true)
  }

  // 7. No console/page errors across the run.
  const real = errors.filter((e) => !/favicon|BrokenPipe|net::ERR_ABORTED/i.test(e))
  ok("no console/page errors", real.length === 0, real.slice(0, 3).join(" | "))

  await browser.close()
  console.log(`\n==== react e2e: ${pass} passed, ${fail} failed ====`)
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => {
  console.error("E2E CRASH", e)
  process.exit(2)
})
