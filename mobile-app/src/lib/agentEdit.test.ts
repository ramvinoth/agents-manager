import test from "node:test"
import assert from "node:assert/strict"
import { NAME_MAX, draftBlocker, draftFrom, draftPayload, pickable, pluginLabel, pluginRows, sameDraft } from "./agentEdit.ts"

const role = {
  id: 3, name: "Engineer", description: "d", category: "engineering", icon: "code",
  system_prompt: "sp", goal: "g", level: "lead" as const,
  jobs: [{ prompt: "daily", cron: "0 9 * * *" }, { prompt: "once", at: "2026-10-12T09:00:00Z" }],
  plugin: "engineer", lens: "map", is_builtin: true, created_by: "", created_at: 0,
}

test("a new draft has the server's defaults", () => {
  const d = draftFrom()
  assert.equal(d.category, "personal")
  assert.equal(d.icon, "sparkle")
  assert.equal(d.level, "ic")
  assert.equal(draftBlocker(d), "Name the agent")
})

test("editing keeps plugin and lens (an update replaces every field) and drops one-shot jobs", () => {
  const p = draftPayload(draftFrom(role))
  assert.equal(p.plugin, "engineer")
  assert.equal(p.lens, "map")
  assert.deepEqual(p.jobs, [{ prompt: "daily", cron: "0 9 * * *" }])
})

test("an unknown category falls back to personal", () => {
  assert.equal(draftFrom({ ...role, category: "general" }).category, "personal")
})

test("the blocker mirrors the server's name rules", () => {
  assert.equal(draftBlocker({ ...draftFrom(), name: "   " }), "Name the agent")
  assert.match(draftBlocker({ ...draftFrom(), name: "x".repeat(NAME_MAX + 1) }), /under/)
  assert.equal(draftBlocker({ ...draftFrom(), name: "Coach" }), "")
})

test("the payload trims text and sends interval jobs as interval", () => {
  const p = draftPayload({ ...draftFrom(), name: "  Coach ", goal: " win ", jobs: [{ prompt: "p", interval: 1800 }] })
  assert.equal(p.name, "Coach")
  assert.equal(p.goal, "win")
  assert.deepEqual(p.jobs, [{ prompt: "p", interval: 1800 }])
})

test("plugins: a kept list wins, else the agent's one seeded plugin, and the payload carries it", () => {
  assert.deepEqual(draftFrom(role).plugins, ["engineer"])
  assert.deepEqual(draftFrom({ ...role, plugins: [] }).plugins, [])
  assert.deepEqual(draftFrom({ ...role, plugins: ["a", "b"] }).plugins, ["a", "b"])
  assert.deepEqual(draftFrom().plugins, [])
  assert.deepEqual(draftPayload(draftFrom({ ...role, plugins: ["a"] })).plugins, ["a"])
})

test("From this Mac offers what the agent lacks, once per name, never a plugin's MCP", () => {
  const machine = [
    { name: "review", scope: "global" }, { name: "db", scope: "project" },
    { name: "db", scope: "global" }, { name: "browser", scope: "plugin:web" }, { name: "kept", scope: "global" },
  ]
  assert.deepEqual(pickable(machine, [{ name: "kept" }]).map((r) => `${r.name}:${r.scope}`), ["review:global", "db:project"])
  assert.deepEqual(pickable([{ name: "notes" }], []).map((r) => r.name), ["notes"])
})

test("unsaved changes: only what Save would send counts", () => {
  const base = draftFrom(role)
  assert.equal(sameDraft(base, draftFrom(role)), true)
  assert.equal(sameDraft(base, { ...base, goal: "g " }), true) // trimmed away
  assert.equal(sameDraft(base, { ...base, goal: "new" }), false)
  assert.equal(sameDraft(base, { ...base, jobs: [] }), false)
})

test("AI: none means the owner's defaults; a pinned one round-trips and counts as a change", () => {
  assert.equal(draftPayload(draftFrom(role)).ai, null)
  const ai = { provider: "p1", model: { kind: "id" as const, id: "qwen" }, convMode: "agent" as const, effort: "" }
  const d = draftFrom({ ...role, ai })
  assert.deepEqual(draftPayload(d).ai, ai)
  assert.equal(sameDraft(d, draftFrom(role)), false)
})

test("plugin picker: filters by name or description, the agent's own first, at catalog scale", () => {
  const catalog = Array.from({ length: 1000 }, (_, i) => ({ name: `p-${i}`, description: i % 2 ? "security scan" : "notes" }))
  const rows = pluginRows(catalog, ["p-999", "p-1"], "")
  assert.equal(rows.length, 1000)
  assert.deepEqual(rows.slice(0, 2).map((p) => p.name), ["p-1", "p-999"])
  assert.equal(pluginRows(catalog, [], "  SECURITY ").length, 500)
  assert.deepEqual(pluginRows(catalog, ["p-2"], "p-2").map((p) => p.name).slice(0, 2), ["p-2", "p-20"])
  assert.equal(pluginLabel("cyber-security"), "Cyber security")
})
