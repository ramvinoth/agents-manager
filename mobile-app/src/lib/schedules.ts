// schedules.ts — the Profile screen's scheduling controls as two plain on/off
// choices ("your schedules", "the agents' schedules") over the server's single
// loop_control mode (viewer/loops.LOOP_MODES), plus ONE truthful line saying
// what actually runs. Truth = viewer/engine.fire_due_loops: a mode licenses
// origins, and the automation master switch additionally halts agent-origin
// loops — so "agents' schedules on" with automation off still runs nothing.
// DUPLICATED in web/src/lib/schedules.ts (the apps share no build) — keep in sync BY HAND
// (roleLabel is mobile-only: the web panel shows no identity card).
import type { LoopMode } from "../api/client"

export type ScheduleFlags = { mine: boolean; agents: boolean }

export function scheduleFlags(mode: LoopMode): ScheduleFlags {
  return { mine: mode === "user" || mode === "both", agents: mode === "harman" || mode === "both" }
}

export function loopModeFor({ mine, agents }: ScheduleFlags): LoopMode {
  return mine ? (agents ? "both" : "user") : agents ? "harman" : "none"
}

/** What fires right now, in one sentence. `automation` is undefined when unknown
 *  (unreachable or a server too old to have the switch): then the agents' side
 *  can't be stated, and the line says so instead of guessing. */
export function scheduleSummary(mode: LoopMode, automation: boolean | undefined): string {
  const { mine, agents } = scheduleFlags(mode)
  if (agents && automation === undefined) return mine ? "Your schedules run. Whether the agents' run is unknown." : "Your schedules are paused. Whether the agents' run is unknown."
  const agentsRun = agents && automation === true
  if (mine && agentsRun) return "Running now: your schedules and the agents' own."
  if (mine) return "Running now: only your schedules. Agents start nothing on their own."
  if (agentsRun) return "Running now: only the agents' own schedules. Yours are paused."
  return "Nothing runs on a schedule. Agents work only when you message them."
}

/** The hint under the agents' switch: why it is on yet does nothing, if so. */
export function agentScheduleHint(mode: LoopMode, automation: boolean | undefined): string {
  if (!scheduleFlags(mode).agents) return "Jobs an agent scheduled for itself stay paused."
  if (automation === false) return "Paused while “Let agents work on their own” is off."
  return "Jobs an agent scheduled for itself (follow-ups, check-ins) fire on time."
}

/** The server account's role (viewer/orglogic.HUMAN_ROLES) in words. */
export function roleLabel(role: string | undefined): string {
  if (role === "owner") return "Owner of this server"
  if (role === "operator") return "Operator — can run work, not change server settings"
  if (role === "viewer") return "Viewer — read-only on this server"
  return "Signed in"
}
