"use strict"
const test = require("node:test")
const assert = require("node:assert/strict")
const s = require("./state")

test("a server that answers is opened, even when its DB is down", () => {
  assert.equal(s.decide({ ok: true, version: "1.0.0" }, false), "open")
  assert.equal(s.decide({ ok: false, db_ok: false }, true), "open")
})

test("no answer: start when installed, install when not", () => {
  assert.equal(s.decide(null, true), "start")
  assert.equal(s.decide(null, false), "install")
})

test("a non-healthz answer (another app on the port) is not Harman", () => {
  assert.equal(s.decide("<html>", false), "install")
  assert.equal(s.decide({ detail: "Not Found" }, true), "start")
})

test("start never force-restarts a running server", () => {
  const [cmd, args] = s.startCommand("darwin", 501)
  assert.equal(cmd, "launchctl")
  assert.deepEqual(args, ["kickstart", "gui/501/com.harman.viewer"])
  assert.ok(!args.includes("-k"))
  assert.equal(s.startCommand("win32", 0), null)
})

test("guiPath puts Homebrew and ~/.local/bin first without duplicates", () => {
  const p = s.guiPath("/usr/bin:/bin:/opt/homebrew/bin", "/Users/x").split(":")
  assert.deepEqual(p.slice(0, 4), ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/Users/x/.local/bin"])
  assert.equal(p.filter((d) => d === "/opt/homebrew/bin").length, 1)
  assert.deepEqual(p.slice(4), ["/usr/bin", "/bin"])
  assert.equal(s.guiPath(undefined, "/h").split(":").length, 4)
})

test("service file and unattended install per platform", () => {
  assert.match(s.serviceFile("darwin", "/Users/x"), /LaunchAgents\/com\.harman\.viewer\.plist$/)
  assert.equal(s.serviceFile("win32", "C:\\"), null)
  assert.equal(s.canInstallUnattended("darwin"), true)
  assert.equal(s.canInstallUnattended("linux"), false)
})
