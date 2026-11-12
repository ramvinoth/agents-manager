import assert from "node:assert/strict"
import { callSession, fmtElapsed, showCallPill } from "./callSession.ts"

assert.equal(callSession.get().active, false)
let ticks = 0
const off = callSession.subscribe(() => ticks++)
assert.equal(callSession.start("Chat A", "p/a.jsonl"), true)
assert.equal(callSession.start("Chat B", "p/b.jsonl"), false, "a live call is never replaced")
assert.equal(callSession.get().label, "Chat A")
callSession.setRoute("Thread")
assert.equal(showCallPill(callSession.get()), true)
callSession.setRoute("Call")
assert.equal(showCallPill(callSession.get()), false, "no pill on the call screen")
callSession.setRoute("Call")
const before = ticks
callSession.setRoute("Call")
assert.equal(ticks, before, "same route does not notify")
callSession.end()
callSession.setRoute("Home")
assert.equal(showCallPill(callSession.get()), false)
callSession.end()
off()
assert.equal(fmtElapsed(65), "1:05")
assert.equal(fmtElapsed(0), "0:00")
console.log("callSession ok")
