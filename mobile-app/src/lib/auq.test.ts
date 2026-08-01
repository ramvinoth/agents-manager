import assert from "node:assert"
import { allAnswered, composeAnswer, isInstant, parseQuestions, pickOption } from "./auq.ts"

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

const REAL_INPUT = {
  questions: [
    {
      question: "How should I authenticate the TestFlight upload?",
      header: "Upload auth",
      multiSelect: false,
      options: [
        { label: "API key", description: "Scoped and revocable" },
        { label: "App-specific password", description: "Tied to your Apple ID" },
      ],
    },
  ],
}

test("parses a real AskUserQuestion input", () => {
  const qs = parseQuestions(REAL_INPUT)
  assert.equal(qs.length, 1)
  assert.equal(qs[0].options.length, 2)
  assert.equal(qs[0].options[0].label, "API key")
  assert.equal(qs[0].multiSelect, false)
})

test("accepts bare-string options and drops empties", () => {
  const qs = parseQuestions({ questions: [{ question: "Pick", options: ["a", "", { label: "b" }] }] })
  assert.deepEqual(qs[0].options.map((o) => o.label), ["a", "b"])
})

test("tolerates junk input", () => {
  assert.deepEqual(parseQuestions(null), [])
  assert.deepEqual(parseQuestions({ questions: "nope" }), [])
  assert.deepEqual(parseQuestions({ questions: [{ noQuestion: true }] }), [])
})

test("single-select replaces, multi-select toggles", () => {
  let p = pickOption({}, 0, "a", false)
  p = pickOption(p, 0, "b", false)
  assert.deepEqual(p[0], ["b"], "single-select keeps only the last pick")
  let m = pickOption({}, 0, "a", true)
  m = pickOption(m, 0, "b", true)
  assert.deepEqual(m[0], ["a", "b"])
  m = pickOption(m, 0, "a", true)
  assert.deepEqual(m[0], ["b"], "re-tap deselects")
})

test("instant answer only for a lone single-select question", () => {
  assert.equal(isInstant(parseQuestions(REAL_INPUT)), true)
  assert.equal(isInstant(parseQuestions({ questions: [{ question: "q", multiSelect: true, options: ["a"] }] })), false)
  assert.equal(
    isInstant(parseQuestions({ questions: [{ question: "q1", options: ["a"] }, { question: "q2", options: ["b"] }] })),
    false
  )
})

test("composeAnswer: single question embeds the question text", () => {
  const qs = parseQuestions(REAL_INPUT)
  assert.equal(
    composeAnswer(qs, { 0: ["API key"] }),
    'You asked: "How should I authenticate the TestFlight upload?" → API key'
  )
})

test("composeAnswer: multiple questions each embed their question", () => {
  const qs = parseQuestions({
    questions: [
      { question: "Auth?", options: ["key"] },
      { question: "Bundle?", options: ["com.suhai.agents"] },
    ],
  })
  const out = composeAnswer(qs, { 0: ["key"], 1: ["com.suhai.agents"] })
  assert.equal(out, 'You asked: "Auth?" → key\nYou asked: "Bundle?" → com.suhai.agents')
})

test("allAnswered gates the submit button", () => {
  const qs = parseQuestions({ questions: [{ question: "a", options: ["x"] }, { question: "b", options: ["y"] }] })
  assert.equal(allAnswered(qs, { 0: ["x"] }), false)
  assert.equal(allAnswered(qs, { 0: ["x"], 1: ["y"] }), true)
  assert.equal(allAnswered([], {}), false)
})

test("composeAnswer: multi-select joins picks with a comma", () => {
  const qs = parseQuestions({ questions: [{ question: "Which features?", multiSelect: true, options: ["a", "b", "c"] }] })
  assert.equal(composeAnswer(qs, { 0: ["a", "c"] }), 'You asked: "Which features?" → a, c')
})

test("composeAnswer: multi-select across multiple questions", () => {
  const qs = parseQuestions({
    questions: [
      { question: "Sources?", multiSelect: true, options: ["docs", "photos"] },
      { question: "Mode?", multiSelect: false, options: ["safe"] },
    ],
  })
  const out = composeAnswer(qs, { 0: ["docs", "photos"], 1: ["safe"] })
  assert.equal(out, 'You asked: "Sources?" → docs, photos\nYou asked: "Mode?" → safe')
})

test("composeAnswer: skips a question with no pick", () => {
  const qs = parseQuestions({ questions: [{ question: "A?", options: ["x"] }, { question: "B?", options: ["y"] }] })
  assert.equal(composeAnswer(qs, { 0: ["x"] }), 'You asked: "A?" → x')
})

test("parses input delivered as a JSON STRING (streaming transport)", () => {
  // The live path sometimes hands tool args over un-parsed — the app must still
  // render the chips instead of dumping raw JSON.
  const qs = parseQuestions(JSON.stringify(REAL_INPUT))
  assert.equal(qs.length, 1)
  assert.equal(qs[0].options.length, 2)
})

test("parses a bare array of questions and a single question object", () => {
  assert.equal(parseQuestions([{ question: "A?", options: ["x"] }]).length, 1)
  assert.equal(parseQuestions({ question: "Solo?", options: ["y", "z"] }).length, 1)
})

test("non-JSON string yields no questions (no crash)", () => {
  assert.deepEqual(parseQuestions("not json at all"), [])
  assert.deepEqual(parseQuestions(undefined), [])
})

console.log(`${passed} passing`)
