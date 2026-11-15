import test from "node:test"
import assert from "node:assert/strict"
import { addLine, brainLabel, latestFallback } from "./callTranscript.ts"

test("addLine appends in order with increasing ids and skips blanks", () => {
  let l = addLine([], "you", "  hi ")
  l = addLine(l, "you", "   ")
  l = addLine(l, "harman", "hello", { servedBy: "Qwen" })
  assert.deepEqual(l.map((x) => [x.id, x.who, x.text]), [[1, "you", "hi"], [2, "harman", "hello"]])
  assert.equal(l[1].servedBy, "Qwen")
  assert.equal("fallback" in l[1], false)
})

test("addLine keeps only the newest lines", () => {
  let l: ReturnType<typeof addLine> = []
  for (let i = 0; i < 250; i++) l = addLine(l, "you", `m${i}`)
  assert.equal(l.length, 200)
  assert.equal(l[199].text, "m249")
})

test("brainLabel prefers who served the latest reply, then the engine, never invents", () => {
  const l = addLine(addLine([], "harman", "a", { servedBy: "LFM3-Audio" }), "harman", "b", { servedBy: "Qwen", fallback: "LFM3-Audio failed" })
  assert.equal(brainLabel("LFM3-Audio", l), "Qwen")
  assert.equal(brainLabel("Speakrail voice + Qwen", []), "Speakrail voice + Qwen")
  assert.equal(brainLabel("", []), "call brain")
  assert.equal(brainLabel(null, []), null)
})

test("old server: replies carry no served_by, label falls back to the engine", () => {
  const l = addLine([], "harman", "hi")
  assert.equal(brainLabel("Qwen", l), "Qwen")
})

test("latestFallback reflects only the newest reply", () => {
  let l = addLine([], "harman", "a", { fallback: "failed" })
  assert.equal(latestFallback(l), "failed")
  l = addLine(l, "harman", "b", { servedBy: "Qwen" })
  assert.equal(latestFallback(l), "")
})
