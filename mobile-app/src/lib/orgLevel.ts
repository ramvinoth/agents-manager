import type { OrgLevel } from "../api/client"

/** The Manager authority levels, least → most (viewer/orglogic.LEVELS). The keys
 *  are wire values; a person reads LEVEL_NAME ("ic" is never shown). */
export const ORG_LEVELS: readonly OrgLevel[] = ["ic", "lead", "manager"]

/** Mirrors viewer/orglogic.LEVEL_NAMES — named by reach, never a job title. */
export const LEVEL_NAME: Record<OrgLevel, string> = { ic: "Own work", lead: "Workspace", manager: "Organization" }

/** What each level reaches without asking (viewer/orglogic). Above it, the ask waits for the owner. */
export const LEVEL_REACH: Record<OrgLevel, string> = {
  ic: "its own cards, notes and messages",
  lead: "also projects, board columns and scheduled loops",
  manager: "also org-wide settings",
}

export function isOrgLevel(v: unknown): v is OrgLevel {
  return typeof v === "string" && (ORG_LEVELS as readonly string[]).includes(v)
}
