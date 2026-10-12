import test from "node:test"
import assert from "node:assert/strict"
import { NAME_MAX, draftBlocker, draftFrom, draftPayload, pickable, sameDraft } from "./agentEdit.ts"

const role = {
  id: 3, name: "Engineer", description: "d", category: "engineering", icon: "code",
  system_prompt: "sp", goal: "g", model: "opus", level: "lead" as const,
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
