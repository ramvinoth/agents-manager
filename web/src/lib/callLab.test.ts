import assert from "node:assert/strict"
import { labStep, audioUrl, fmtMs, emptyTurn, median, medianTtfa, labNoteBody, labNoteTitle } from "./callLab.ts"

assert.deepEqual(labStep({ audio: "a1", next: "n1" }), { kind: "play", audio: "a1", next: "n1" })
assert.deepEqual(labStep({ reply: "  hi " }), { kind: "text", text: "hi" })
assert.deepEqual(labStep({ reply: "  " }), { kind: "done" })
assert.deepEqual(labStep({ audio: "a1" }), { kind: "done" })


assert.equal(audioUrl("projects/a b/x.jsonl", "s&1"), "/api/call/audio?path=projects%2Fa%20b%2Fx.jsonl&id=s%261")

assert.equal(fmtMs(null), "–")
assert.equal(fmtMs(450.4), "450 ms")
assert.equal(fmtMs(1740), "1.7 s")

assert.equal(median([]), null)
assert.equal(median([3, 1, 2]), 2)
assert.equal(median([4, 1, 2, 3]), 2.5)

const a = { ...emptyTurn(1, "tell me a story"), ttfaMs: 1900, totalMs: 6000, said: "Once upon a time", verdict: "up" as const }
const b = { ...emptyTurn(2, "what is on my board"), ttfaMs: 2100, tools: ["list_cards"], interrupted: true, verdict: "down" as const, note: " cut off early " }
const c = emptyTurn(3, "text only")
assert.equal(medianTtfa([a, b, c]), 2000)
assert.equal(medianTtfa([c]), null)

const body = labNoteBody({ engine: "brain", model: "LFM3-Audio" }, [a, b, c])
assert.match(body, /Engine: brain \(LFM3-Audio\)/)
assert.match(body, /Median time to first audio: 2\.0 s/)
assert.match(body, /1\. 👍 "tell me a story"/)
assert.match(body, /interrupted; tools: list_cards/)
assert.match(body, /note: cut off early/)
assert.match(body, /3\. · "text only"/)

assert.equal(labNoteTitle({ engine: "brain", model: "LFM3-Audio" }, new Date("2026-11-12T18:30:45Z")), "Voice Lab: brain LFM3-Audio 2026-11-12 18:30")
console.log("callLab ok")
