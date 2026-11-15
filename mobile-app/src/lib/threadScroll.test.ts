import assert from "node:assert/strict"
import { test } from "node:test"
import { PIN_THRESHOLD, shouldPinToNewest } from "./threadScroll.ts"

test("pin while the reader is at the bottom (jump button hidden)", () => {
  assert.equal(shouldPinToNewest(0), true) // freshly opened, pinned
  assert.equal(shouldPinToNewest(100), true) // near the newest, following the run
  assert.equal(shouldPinToNewest(PIN_THRESHOLD), true) // right at the line the button appears
})

test("never pin a reader who has scrolled up into history", () => {
  assert.equal(shouldPinToNewest(PIN_THRESHOLD + 1), false) // jump button visible
  assert.equal(shouldPinToNewest(5000), false) // deep in history
})
