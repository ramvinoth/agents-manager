import {
  aiSummary,
  discoveryHint,
  modelChoices,
  modelLabel,
  providerLabel,
  sameAI,
  selectionProblem,
  switchAIProvider,
  type AICapabilities,
  type AISelection,
  type ModelDiscovery,
} from "./aiSelection.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const claude: AISelection = { provider: "", model: { kind: "default" }, convMode: "agent", effort: "" }
const custom: AISelection = { provider: "p1", model: { kind: "id", id: "qwen3-27b" }, convMode: "chat", effort: "" }
const providers = [{ id: "p1", name: "Suha Qwen" }]
const caps: AICapabilities = { editable: true, customProviders: true, conversationModes: ["agent", "chat"], efforts: [""], manualModelId: true }

eq("same selection is equal", sameAI(custom, { ...custom }), true)
eq("different model id is not equal", sameAI(custom, { ...custom, model: { kind: "id", id: "other" } }), false)
eq("default vs id is not equal", sameAI(claude, { ...claude, model: { kind: "id", id: "x" } }), false)

eq("switching provider resets model/mode/effort", switchAIProvider(custom, ""), claude)
eq("switching back restores the earlier draft", switchAIProvider(claude, "p1", custom), custom)
eq("same provider is a no-op", switchAIProvider(custom, "p1"), custom)

eq("model label: null", modelLabel(null), "Model from the request")
eq("model label: default", modelLabel({ kind: "default" }), "Provider default model")
eq("model label: id", modelLabel({ kind: "id", id: "m" }), "m")
eq("provider label: built-in", providerLabel("", providers), "Claude (your login)")
eq("provider label: missing preset", providerLabel("gone", providers), "Unavailable connection (gone)")

eq("summary: plain claude is short", aiSummary(claude, providers), "Claude (your login)")
eq("summary: claude with effort", aiSummary({ ...claude, effort: "high" }, providers), "Claude (your login) · high effort")
eq("summary: custom shows model and mode", aiSummary(custom, providers), "Suha Qwen · qwen3-27b · chat mode")

eq("problem: unknown caps is not a problem yet", selectionProblem(custom, null, providers), null)
eq("problem: valid custom", selectionProblem(custom, caps, providers), null)
eq("problem: deleted provider", selectionProblem({ ...custom, provider: "gone" }, caps, providers), "The selected connection no longer exists. Choose another provider.")
eq("problem: remote host forbids custom", selectionProblem(custom, { ...caps, customProviders: false }, providers), "Custom providers run only on this machine with Claude.")
eq("problem: effort not offered", selectionProblem({ ...custom, effort: "high" }, caps, providers), "That effort level is not available for this provider.")
eq("problem: empty manual id", selectionProblem({ ...custom, model: { kind: "id", id: " " } }, caps, providers), "Enter a model ID or pick the provider default.")
eq("problem: not editable", selectionProblem(claude, { ...caps, editable: false }, providers), "AI settings cannot be changed for this agent.")

const disc: ModelDiscovery = { models: ["b", "a"], choices: [{ id: "b", label: "B" }, { id: "a", label: "A" }], status: "ok", source: "endpoint", manualModelId: true }
eq("choices sorted by id", modelChoices(disc, { kind: "default" }, "").map((r) => r.id), ["a", "b"])
eq("current manual id is appended when undiscovered", modelChoices(disc, { kind: "id", id: "z" }, "")[2], { id: "z", label: "z (current; not in discovered list)" })
eq("search filters by id or label", modelChoices(disc, null, "B").map((r) => r.id), ["b"])
eq("no discovery yields no rows", modelChoices(null, { kind: "default" }, ""), [])

eq("hint: loading wins", discoveryHint(disc, true), "Loading model choices…")
eq("hint: error text passes through", discoveryHint({ ...disc, status: "error", error: "boom" }, false), "boom")
eq("hint: unsupported", discoveryHint({ ...disc, status: "unsupported" }, false).startsWith("This endpoint does not list"), true)
eq("hint: nothing before discovery", discoveryHint(null, false), "")

console.log(`aiSelection: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
