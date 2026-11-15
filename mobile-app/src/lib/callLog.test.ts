import test from "node:test"
import assert from "node:assert/strict"
import { mergeCalls, callLength, callPreview, speakerLabel, type CallEntry } from "./callLog.ts"

const call = (id: string, lines: CallEntry["transcript"] = []): CallEntry => ({ call_id: id, agent: "Harman", started: 1, duration: 5, turns: 1, transcript: lines })

test("mergeCalls keeps order and drops duplicates", () => {
  const out = mergeCalls([call("a"), call("b")], [call("b"), call("c")])
  assert.deepEqual(out.map(c => c.call_id), ["a", "b", "c"])
})

test("callLength formats seconds and minutes", () => {
  assert.equal(callLength(45.4), "45 s")
  assert.equal(callLength(192), "3 min 12 s")
  assert.equal(callLength(-3), "0 s")
})

test("callPreview uses the first caller line, falls back", () => {
  assert.equal(callPreview(call("a", [{ who: "agent", text: "Hi", ts: 0 }, { who: "caller", text: "Hello", ts: 1 }])), "Hello")
  assert.equal(callPreview(call("b")), "No words were recorded")
})

test("speakerLabel", () => {
  assert.equal(speakerLabel("caller"), "You")
  assert.equal(speakerLabel("agent"), "Agent")
})
