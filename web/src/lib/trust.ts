// A chat's Trust: the two server-side policies that gate what its agent may do.
// Mirrors mobile-app (SessionProfileScreen Trust card + lib/orgLevel).

/** Manager authority, least → most (viewer/orglogic.LEVELS). The keys are wire
 *  values; a person reads LEVEL_NAME ("ic" is never shown). */
export type OrgLevel = "ic" | "lead" | "manager"
export const ORG_LEVELS: readonly OrgLevel[] = ["ic", "lead", "manager"]
/** Mirrors viewer/orglogic.LEVEL_NAMES — named by reach, never a job title. */
export const LEVEL_NAME: Record<OrgLevel, string> = { ic: "Own work", lead: "Workspace", manager: "Organization" }
export function isOrgLevel(v: unknown): v is OrgLevel {
  return typeof v === "string" && (ORG_LEVELS as readonly string[]).includes(v)
}

/** The saved Claude Code permission policy (session_meta.permission_mode). */
export type PermissionPolicy = "acceptEdits" | "default" | "plan" | "bypass"
export const POLICIES: { v: PermissionPolicy; label: string }[] = [
  { v: "acceptEdits", label: "Accept edits" },
  { v: "default", label: "Ask" },
  { v: "plan", label: "Plan" },
  { v: "bypass", label: "Bypass" },
]

export type TrustWrite = { session?: string; permission_mode?: string; level?: string; error?: string; queued?: boolean; denied?: boolean; reason?: string }

/** What a Trust write did, in words: `applied` only when the server confirms
 *  the exact change on the exact chat; a queued ask is not an applied one. */
export function trustOutcome(r: TrustWrite, target: string, field: "permission_mode" | "level", want: string):
  { applied: boolean; note: string } {
  if (r.queued) return { applied: false, note: "Sent to the owner for approval; nothing has changed yet." }
  if (r.error || r.denied) return { applied: false, note: r.error || r.reason || "Refused by the server." }
  if (r.session !== target || (r[field] ?? "") !== want) {
    return { applied: false, note: "The server did not confirm the change. Reload before retrying." }
  }
  return { applied: true, note: "" }
}
