import assert from "node:assert"
import {
  AUTO_OPEN_AWAY_MS, commentPurpose, commentResolves, deckActions, deckSwipe,
  overscrollStep, shouldAutoOpenDeck, verdictColumn,
} from "./decisionDeck.ts"

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

test("deckSwipe: a long drag right approves, left denies", () => {
  assert.equal(deckSwipe({ dx: 140, dy: 10, vx: 0 }), "approve")
  assert.equal(deckSwipe({ dx: -140, dy: -10, vx: 0 }), "deny")
})

test("deckSwipe: a short slow drag springs back", () => {
  assert.equal(deckSwipe({ dx: 80, dy: 0, vx: 100 }), null)
  assert.equal(deckSwipe({ dx: -80, dy: 0, vx: -100 }), null)
})

test("deckSwipe: a quick flick decides even when short", () => {
  assert.equal(deckSwipe({ dx: 50, dy: 5, vx: 1200 }), "approve")
  assert.equal(deckSwipe({ dx: -50, dy: 5, vx: -1200 }), "deny")
})

test("deckSwipe: a flick against the drag, or a twitch, decides nothing", () => {
  assert.equal(deckSwipe({ dx: 60, dy: 0, vx: -1200 }), null)
  assert.equal(deckSwipe({ dx: 20, dy: 0, vx: 1500 }), null)
})

test("deckSwipe: a mostly vertical drag is a scroll, never a verdict", () => {
  assert.equal(deckSwipe({ dx: 150, dy: 120, vx: 0 }), null)
  assert.equal(deckSwipe({ dx: -150, dy: -200, vx: -2000 }), null)
})

test("deckSwipe: garbage input decides nothing", () => {
  assert.equal(deckSwipe({ dx: NaN, dy: 0, vx: 0 }), null)
  assert.equal(deckSwipe({ dx: Infinity, dy: 0, vx: 0 }), null)
})

test("overscrollStep: a pull past the top goes back, past the bottom goes on", () => {
  assert.equal(overscrollStep({ offsetY: -80, contentH: 2000, viewH: 700 }), "prev")
  assert.equal(overscrollStep({ offsetY: 1380, contentH: 2000, viewH: 700 }), "next")
})

test("overscrollStep: scrolling inside a long card does not page", () => {
  assert.equal(overscrollStep({ offsetY: 0, contentH: 2000, viewH: 700 }), null)
  assert.equal(overscrollStep({ offsetY: 650, contentH: 2000, viewH: 700 }), null)
  assert.equal(overscrollStep({ offsetY: 1330, contentH: 2000, viewH: 700 }), null)
  assert.equal(overscrollStep({ offsetY: -30, contentH: 2000, viewH: 700 }), null)
})

test("overscrollStep: a short card pages either way", () => {
  assert.equal(overscrollStep({ offsetY: 70, contentH: 300, viewH: 700 }), "next")
  assert.equal(overscrollStep({ offsetY: -70, contentH: 300, viewH: 700 }), "prev")
  assert.equal(overscrollStep({ offsetY: 20, contentH: 300, viewH: 700 }), null)
})

test("overscrollStep: garbage input stays put", () => {
  assert.equal(overscrollStep({ offsetY: NaN, contentH: 300, viewH: 700 }), null)
})

test("deckActions: a question is answered, never approved or denied", () => {
  assert.deepEqual(deckActions("question"), { approve: false, deny: false, comment: true })
  for (const k of ["plan", "approval", "card", "red"] as const) {
    assert.deepEqual(deckActions(k), { approve: true, deny: true, comment: true })
  }
})

test("commentResolves: only a reply, plan notes and a card comment settle the item", () => {
  assert.equal(commentResolves("question"), true)
  assert.equal(commentResolves("plan"), true)
  assert.equal(commentResolves("card"), true)
  assert.equal(commentResolves("approval"), false)
  assert.equal(commentResolves("red"), false)
})

test("commentPurpose: every kind tells the owner where the words go", () => {
  for (const k of ["question", "plan", "approval", "card", "red"] as const) {
    const p = commentPurpose(k)
    assert.ok(p.title && p.hint && p.send)
  }
  assert.match(commentPurpose("approval").hint, /stays open/)
})

test("verdictColumn: finds Approved / Declined by name, any case", () => {
  const cols = [{ id: 1, name: "Todo" }, { id: 4, name: " approved" }, { id: 5, name: "DECLINED" }]
  assert.equal(verdictColumn(cols, "approve"), 4)
  assert.equal(verdictColumn(cols, "deny"), 5)
})

test("verdictColumn: a board without the column says so", () => {
  assert.equal(verdictColumn([{ id: 1, name: "Todo" }], "approve"), null)
  assert.equal(verdictColumn([], "deny"), null)
  assert.equal(verdictColumn([{ id: 2, name: "Approved-ish" }], "approve"), null)
})

test("shouldAutoOpenDeck: opens on launch with decisions waiting", () => {
  assert.equal(shouldAutoOpenDeck({ count: 2, deepLinkPending: false, deckOpen: false, awayMs: null }), true)
})

test("shouldAutoOpenDeck: never with nothing waiting, a notification tap pending, or already open", () => {
  assert.equal(shouldAutoOpenDeck({ count: 0, deepLinkPending: false, deckOpen: false, awayMs: null }), false)
  assert.equal(shouldAutoOpenDeck({ count: 3, deepLinkPending: true, deckOpen: false, awayMs: null }), false)
  assert.equal(shouldAutoOpenDeck({ count: 3, deepLinkPending: false, deckOpen: true, awayMs: null }), false)
})

test("shouldAutoOpenDeck: on return only after a real absence", () => {
  assert.equal(shouldAutoOpenDeck({ count: 1, deepLinkPending: false, deckOpen: false, awayMs: 30_000 }), false)
  assert.equal(shouldAutoOpenDeck({ count: 1, deepLinkPending: false, deckOpen: false, awayMs: AUTO_OPEN_AWAY_MS }), true)
})

console.log(`${passed} passing`)
