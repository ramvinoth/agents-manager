import test from "node:test"
import assert from "node:assert/strict"
import { agentScheduleHint, loopModeFor, roleLabel, scheduleFlags, scheduleSummary } from "./schedules.ts"

const MODES = ["user", "agent", "both", "none"] as const

test("the two switches round-trip every server mode", () => {
  for (const m of MODES) assert.equal(loopModeFor(scheduleFlags(m)), m)
})

test("the summary matches the engine: agent loops need the mode AND automation", () => {
  assert.match(scheduleSummary("agent", false), /^Nothing runs/, "agent-only mode with automation off fires nothing")
  assert.match(scheduleSummary("both", false), /only your schedules/)
  assert.match(scheduleSummary("both", true), /your schedules and the agents'/)
  assert.match(scheduleSummary("agent", true), /only the agents'/)
  assert.match(scheduleSummary("none", true), /^Nothing runs/)
  assert.match(scheduleSummary("user", undefined), /only your schedules/, "unknown automation can't matter in user mode")
  assert.match(scheduleSummary("both", undefined), /unknown/)
})

test("the agents' switch explains when automation holds it", () => {
  assert.match(agentScheduleHint("agent", false), /Paused while/)
  assert.doesNotMatch(agentScheduleHint("both", true), /Paused/)
  assert.match(agentScheduleHint("user", true), /stay paused/)
})

test("role labels never claim ownership they don't have", () => {
  assert.equal(roleLabel("owner"), "Owner of this server")
  for (const r of ["viewer", "operator", undefined, "weird"]) assert.doesNotMatch(roleLabel(r), /^Owner/)
})
