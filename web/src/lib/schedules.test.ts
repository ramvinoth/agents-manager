import assert from "node:assert/strict"
import { agentScheduleHint, loopModeFor, scheduleFlags, scheduleSummary } from "./schedules.ts"

for (const m of ["user", "harman", "both", "none"] as const) assert.equal(loopModeFor(scheduleFlags(m)), m)
assert.match(scheduleSummary("harman", false), /^Nothing runs/, "agent loops need the mode AND automation")
assert.match(scheduleSummary("both", true), /your schedules and the agents'/)
assert.match(agentScheduleHint("harman", false), /Paused while/)
console.log("schedules: ok")
