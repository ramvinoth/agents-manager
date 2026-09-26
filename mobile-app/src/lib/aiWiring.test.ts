import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import ts from "typescript"

const source = (file: string) => readFileSync(`src/lib/${file}`, "utf8")

test("thread sends saved Opus and full IDs without an invented entitlement catalog", () => {
  const text = source("../screens/ThreadScreen.tsx")
  const body = text.match(/const sendPrefs = \(\) => \{([\s\S]*?)\n  \}/)?.[1]
  assert.ok(body)
  const catalog = text.match(/const MODELS = (\[[\s\S]*?\n\])/)?.[1] || "[]"
  const fn = new Function("composerPrefs", `const MODELS = ${catalog}; ${body}`)
  for (const model of ["opus", "vendor/full-model-id"]) {
    assert.equal(fn(() => ({ mode: "default", model })).model, model)
  }
})

test("NewChat includes provider in the first launch rather than a later metadata write", () => {
  const text = source("../screens/NewChatScreen.tsx")
  const body = text.match(/await api.newSession\((\{[\s\S]*?\n      \})\)/)?.[1]
  assert.ok(body)
  const js = ts.transpile(`const payload = ${body}; return payload`, { target: ts.ScriptTarget.ES2022 })
  const fields = { msg: "hello", cwd: "/tmp", mode: "default", model: "opus", host: "local", systemPrompt: "", goal: "", effort: "high", provider: "selected", ai: { provider: "selected", model: { kind: "id", id: "opus" }, convMode: "agent", effort: null }, aiSelection: { provider: "selected", model: { kind: "id", id: "opus" }, convMode: "agent", effort: null } }
  const payload = new Function(...Object.keys(fields), js)(...Object.values(fields))
  assert.equal(payload.ai?.provider ?? payload.provider, "selected")
  assert.doesNotMatch(text, /sessionMetaSave\(\{ session: sessionPath, provider/)
})
