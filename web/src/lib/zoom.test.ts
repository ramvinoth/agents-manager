import { test } from "node:test"
import assert from "node:assert/strict"
import { clampScale, zoomAt, fitView, centered, wheelFactor, MAX_SCALE, MIN_SCALE } from "./zoom.ts"

test("clampScale bounds and rejects junk", () => {
  assert.equal(clampScale(100), MAX_SCALE)
  assert.equal(clampScale(0.0001), MIN_SCALE)
  assert.equal(clampScale(NaN), 1)
  assert.equal(clampScale(-2), 1)
  assert.equal(clampScale(2), 2)
})

test("zoomAt keeps the point under the cursor fixed", () => {
  const v = { x: 10, y: 20, scale: 1 }
  const z = zoomAt(v, 2, 110, 70)
  // content point under (110,70) before: ((110-10)/1, (70-20)/1) = (100,50)
  assert.equal(z.scale, 2)
  assert.equal(100 * z.scale + z.x, 110)
  assert.equal(50 * z.scale + z.y, 70)
})

test("zoomAt at the clamp does not drift the view", () => {
  const v = { x: 5, y: 5, scale: MAX_SCALE }
  assert.deepEqual(zoomAt(v, 2, 300, 300), v)
})

test("fitView shrinks a wide diagram and centres it", () => {
  const v = fitView({ w: 2000, h: 500 }, { w: 1032, h: 800 })
  assert.equal(v.scale, 0.5)
  assert.equal(v.x, 16)
  assert.equal(v.y, (800 - 250) / 2)
})

test("fitView caps enlargement of a tiny diagram", () => {
  assert.equal(fitView({ w: 10, h: 10 }, { w: 1000, h: 1000 }).scale, 2)
})

test("fitView tolerates zero sizes", () => {
  assert.deepEqual(fitView({ w: 0, h: 0 }, { w: 100, h: 100 }), { x: 0, y: 0, scale: 1 })
})

test("centered at 100%", () => {
  assert.deepEqual(centered({ w: 100, h: 50 }, { w: 300, h: 150 }, 1), { scale: 1, x: 100, y: 50 })
})

test("wheelFactor: scroll up zooms in, pinch is more sensitive", () => {
  assert.ok(wheelFactor(-100, false) > 1)
  assert.ok(wheelFactor(100, false) < 1)
  assert.ok(wheelFactor(-10, true) > wheelFactor(-10, false))
})
