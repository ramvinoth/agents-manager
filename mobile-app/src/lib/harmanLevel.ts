import type { HarmanLevel } from "../api/client"

/** The Harman authority levels, least → most (viewer/orglogic.LEVELS). The keys
 *  are wire values; a person reads LEVEL_NAME ("ic" is never shown). */
export const HARMAN_LEVELS: readonly HarmanLevel[] = ["ic", "lead", "manager"]

/** Mirrors viewer/orglogic.LEVEL_NAMES — named by reach, never a job title. */
export const LEVEL_NAME: Record<HarmanLevel, string> = { ic: "Own work", lead: "Workspace", manager: "Organization" }

/** What each level reaches without asking (viewer/orglogic). Above it, the ask waits for the owner. */
export const LEVEL_REACH: Record<HarmanLevel, string> = {
  ic: "its own cards, notes and messages",
  lead: "also projects, board columns and scheduled loops",
  manager: "also org-wide settings",
}

export function isHarmanLevel(v: unknown): v is HarmanLevel {
  return typeof v === "string" && (HARMAN_LEVELS as readonly string[]).includes(v)
}
