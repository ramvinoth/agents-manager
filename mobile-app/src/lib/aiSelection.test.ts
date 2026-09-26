import assert from "node:assert/strict"
import { test } from "node:test"
import { sameAI, switchAIProvider, connectionPayload, newChatAI, modelChoices, aiError, type AISelection, type AIConfig } from "./aiSelection.ts"
const a: AISelection = { provider: "", model: { kind: "id", id: "opus/full-id" }, convMode: "agent", effort: "high" }
test("provider switch resets dependent fields and can restore draft selection", () => {
  const b = switchAIProvider(a, "custom")
  assert.deepEqual(b, { provider: "custom", model: {kind: "default"}, convMode: "agent", effort: "" })
  assert.deepEqual(switchAIProvider(b, "", a), a)
  assert.equal(sameAI(a, { ...a }), true)
  assert.equal(sameAI(a, { ...a, model: null }), false)
  assert.equal(sameAI({ ...a, model: null }, { ...a, model: {kind: "default"} }), false)
})
test("changed draft endpoint cannot receive kept saved credentials", () => {
  assert.throws(() => connectionPayload({id: "x", baseUrl: "https://new", apiKeyAction: "keep"}, "https://old"), /Endpoint changed/)
  assert.deepEqual(connectionPayload({id: "x", baseUrl: "https://new", apiKeyAction: "remove", apiKey: "secret"}, "https://old"), {id: "x", baseUrl: "https://new", apiKeyAction: "remove"})
  assert.throws(() => connectionPayload({baseUrl: "https://new", apiKeyAction: "replace", apiKey: " "}), /replacement/)
})
test("server defaults trump legacy prefill; unconfigured full IDs preserved", () => {
  const config = {configured: true, selection: a} as AIConfig
  assert.equal(newChatAI(config, "old-model"), a)
  assert.deepEqual(newChatAI({...config, configured: false}, "full/legacy-id").model, {kind: "id", id: "full/legacy-id"})
  assert.deepEqual(newChatAI({...config, configured: false, selection: {...a, provider: "custom"}}, "opus").model, {kind: "default"})
})
test("missing selected IDs remain visible and searchable without a catalog", () => {
  assert.equal(modelChoices(null, a.model, "full-id")[0].id, "opus/full-id")
  assert.equal(modelChoices(null, a.model, "absent").length, 0)
  assert.match(aiError({status: 404}), /Server update required/)
  assert.match(aiError({status: 409}), /draft is kept/)
})
