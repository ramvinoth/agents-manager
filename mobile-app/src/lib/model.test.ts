import assert from "node:assert"
import { normModel } from "./model.ts"

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

test("the 'default' sentinel omits the model (the app-vs-web bug)", () => {
  assert.equal(normModel("default"), undefined)
})

test("blank and whitespace omit the model", () => {
  assert.equal(normModel(""), undefined)
  assert.equal(normModel("   "), undefined)
  assert.equal(normModel(undefined), undefined)
})

test("real aliases pass through", () => {
  assert.equal(normModel("opus"), "opus")
  assert.equal(normModel("sonnet"), "sonnet")
  assert.equal(normModel("haiku"), "haiku")
})

test("full model ids pass through, trimmed", () => {
  assert.equal(normModel(" claude-sonnet-4-5 "), "claude-sonnet-4-5")
})

console.log(`${passed} passing`)
