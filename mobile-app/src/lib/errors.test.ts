import assert from "node:assert/strict"
import { test } from "node:test"
import { isTransportError, userError } from "./errors.ts"

const err = (message: string, status?: number) => Object.assign(new Error(message), { status })

test("server-authored messages pass through", () => {
  assert.equal(userError(err("Not a directory", 404), "this folder"), "Not a directory")
  assert.equal(userError(err("Permission denied: /root", 403), "this folder"), "Permission denied: /root")
})
test("bare HTTP fallbacks never reach the screen", () => {
  assert.equal(userError(err("HTTP 404", 404), "files"), "This server doesn't support files yet. Update Harman on the server.")
  assert.equal(userError(err("HTTP 500", 500), "files"), "Couldn't load files. Try again.")
  assert.equal(userError(err("HTTP 403", 403), "files"), "You don't have access to files.")
})
test("auth, transport and missing server get actionable text", () => {
  assert.equal(userError(err("HTTP 401", 401), "x"), "Your session expired. Sign in again.")
  assert.equal(userError(err("Network request failed"), "x"), "Can't reach the server. Check your connection and try again.")
  assert.equal(userError(err("No server configured"), "x"), "No server set up yet. Add one in Profile.")
})
test("garbage input is safe", () => {
  assert.equal(userError(undefined, "files"), "Couldn't load files. Try again.")
  assert.equal(userError("boom", "files"), "Couldn't load files. Try again.")
})
test("the verb names the failed action", () => {
  assert.equal(userError(err("HTTP 500", 500), "your message", "send"), "Couldn't send your message. Try again.")
})
test("isTransportError: no status + transport text only", () => {
  assert.equal(isTransportError(err("Network request failed (relay closed 1006)")), true)
  assert.equal(isTransportError(err("Network request failed", 502)), false)
  assert.equal(isTransportError(err("No server configured")), false)
  assert.equal(isTransportError(undefined), false)
})
