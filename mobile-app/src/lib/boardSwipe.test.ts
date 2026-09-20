import assert from "node:assert/strict"
import { completesBoardSwipe, shouldClaimBoardSwipe } from "./boardSwipe.ts"

const start = { x0: 390, left: 0, width: 400, dx: -25, dy: 2, touches: 1 }
for (const [name, patch, expected] of [
  ["right edge left drag", {}, true],
  ["inner edge boundary", { x0: 368 }, true],
  ["outer edge boundary", { x0: 400 }, true],
  ["center content", { x0: 367 }, false],
  ["outside viewport", { x0: 401 }, false],
  ["rightward reply", { dx: 80 }, false],
  ["left edge back", { x0: 0, dx: 80 }, false],
  ["vertical scroll", { dy: 50 }, false],
  ["diagonal boundary", { dx: -16, dy: 10 }, false],
  ["jitter", { dx: -14 }, false],
  ["multiple fingers", { touches: 2 }, false],
  ["no fingers", { touches: 0 }, false],
  ["unmeasured", { width: 0 }, false],
  ["invalid geometry", { x0: NaN }, false],
  ["infinite width", { width: Infinity }, false],
  ["offset viewport", { left: 100, x0: 490 }, true],
  ["rotation uses new width", { width: 800, x0: 790 }, true],
  ["old edge after rotation", { width: 800 }, false],
] as const) {
  assert.equal(shouldClaimBoardSwipe({ ...start, ...patch }), expected, name)
}
for (const [name, dx, dy, expected] of [
  ["complete", -80, 2, true],
  ["completion boundary", -56, 0, true],
  ["short", -55, 0, false],
  ["reversed", 20, 0, false],
  ["returned to origin", 0, 0, false],
  ["ended vertically", -80, 80, false],
  ["invalid displacement", -Infinity, 0, false],
  ["invalid vertical", -80, NaN, false],
] as const) {
  assert.equal(completesBoardSwipe({ dx, dy }), expected, name)
}
console.log("boardSwipe: 26 assertions passed")
