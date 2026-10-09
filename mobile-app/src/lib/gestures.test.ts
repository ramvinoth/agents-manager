import assert from "node:assert/strict"
import { completesBoardSwipe, completesMenuSwipe, isTap, menuDragProgress, menuSettlesOpen, shouldClaimBoardSwipe } from "./gestures.ts"

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
for (const [name, dx, dy, expected] of [
  ["menu complete", 80, 2, true],
  ["menu boundary", 56, 0, true],
  ["menu short", 55, 0, false],
  ["leftward pages to Inbox", -80, 0, false],
  ["menu diagonal", 60, 40, false],
  ["menu invalid", NaN, 0, false],
] as const) {
  assert.equal(completesMenuSwipe({ dx, dy }), expected, name)
}

for (const [name, dx, w, expected] of [
  ["shut", 0, 300, 0], ["half", 150, 300, 0.5], ["past full", 900, 300, 1],
  ["leftward", -40, 300, 0], ["unmeasured", 40, 0, 0], ["invalid", NaN, 300, 0],
] as const) {
  assert.equal(menuDragProgress(dx, w), expected, name)
}
for (const [name, dx, dy, vx, expected] of [
  ["completed swipe", 80, 0, 0, true],
  ["short quick flick", 30, 4, 900, true],
  ["short slow drag", 30, 4, 100, false],
  ["flick under activation", 10, 0, 900, false],
  ["diagonal flick", 30, 25, 900, false],
  ["leftward flick", -30, 0, -900, false],
  ["invalid velocity", 30, 0, NaN, false],
] as const) {
  assert.equal(menuSettlesOpen({ dx, dy, vx }), expected, name)
}
for (const [name, up, expected] of [
  ["still", { x: 100, y: 200 }, true],
  ["slop boundary", { x: 110, y: 190 }, true],
  ["short swipe", { x: 140, y: 200 }, false],
  ["leftward swipe", { x: 60, y: 202 }, false],
  ["scrolled", { x: 100, y: 230 }, false],
  ["unknown release", { x: NaN, y: 200 }, false],
] as const) {
  assert.equal(isTap({ x: 100, y: 200 }, up), expected, name)
}
console.log("gestures: assertions passed")
