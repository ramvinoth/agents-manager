import assert from "node:assert"
import { HOST_LOCATION, describeLocation, fsScope, isLiveLocation, vendorLabel } from "./location.ts"

let passed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
  } catch (e) {
    console.error(`✖ ${name}\n  ${(e as Error).message}`)
    process.exitCode = 1
  }
}

const drives = [
  { id: "dr-1", label: "Work Drive", kind: "google", status: "active", hidden: false, authorized: true },
  { id: "dr-2", label: "Dropbox", kind: "dropbox", status: "active", hidden: false, authorized: false },
]

test("vendorLabel names known vendors and passes unknown kinds through", () => {
  assert.equal(vendorLabel("google"), "Google Drive")
  assert.equal(vendorLabel("onedrive"), "OneDrive")
  assert.equal(vendorLabel("box"), "box")
})

test("describeLocation shows the host label on the host and the drive label on a drive", () => {
  assert.equal(describeLocation(HOST_LOCATION, drives, "This machine"), "This machine")
  assert.equal(describeLocation("dr-1", drives, "This machine"), "Work Drive")
})

test("describeLocation never renders a removed drive as a place", () => {
  assert.equal(describeLocation("dr-gone", drives, "suha-ai"), "suha-ai")
})

test("isLiveLocation tracks the drive list", () => {
  assert.equal(isLiveLocation(HOST_LOCATION, []), true)
  assert.equal(isLiveLocation("dr-2", drives), true)
  assert.equal(isLiveLocation("dr-2", []), false)
})

test("fsScope emits exactly one of drive/host, and nothing for local", () => {
  assert.deepEqual(fsScope("local", HOST_LOCATION), {})
  assert.deepEqual(fsScope("", HOST_LOCATION), {})
  assert.deepEqual(fsScope("h-suha", HOST_LOCATION), { host: "h-suha" })
  assert.deepEqual(fsScope("h-suha", "dr-1"), { drive: "dr-1" })
  assert.deepEqual(fsScope("local", "dr-1"), { drive: "dr-1" })
})

console.log(`location.test.ts: ${passed} passed`)
