import type { HarmanLevel } from "../api/client"

/** The Harman authority levels, least → most (viewer/orglogic.LEVELS). The keys
 *  are wire values; a person reads LEVEL_NAME ("ic" is never shown). */
export const HARMAN_LEVELS: readonly HarmanLevel[] = ["ic", "lead", "manager"]

/** Mirrors viewer/orglogic.LEVEL_NAMES — named by reach, never a job title. */
export const LEVEL_NAME: Record<HarmanLevel, string> = { ic: "Own work", lead: "Workspace", manager: "Organization" }

export function isHarmanLevel(v: unknown): v is HarmanLevel {
  return typeof v === "string" && (HARMAN_LEVELS as readonly string[]).includes(v)
}
