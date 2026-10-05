/**
 * Marketplace — pure rules for the install sheet. The server owns the catalog
 * (MCP registry + anthropics/skills) and rebuilds every config from the
 * registry's own record; the app only collects the owner's inputs and scope.
 */
import type { MarketInput, MarketItem } from "../api/client"

export type MarketKind = "mcp" | "skills"
export type InstallScope = "global" | "project"

/** The first required input the owner left blank, or null when the form is complete. */
export function missingInput(inputs: MarketInput[], values: Record<string, string>): MarketInput | null {
  return inputs.find(i => i.required && !(values[i.name] || "").trim()) ?? null
}

/** Only the inputs the owner filled, trimmed — blanks are left to the server's defaults. */
export function filledValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v))
}

/** What the row's badge says: how it runs, or why it can't be installed from here. */
export function installNote(kind: MarketKind, item: MarketItem): string {
  if (kind === "skills") return item.license || "skill"
  if (!item.install) return "Not installable here"
  return item.install === "remote" ? "Hosted" : item.install
}

/** Scopes the sheet offers: a project install needs the session's folder. */
export function scopes(cwd?: string): InstallScope[] {
  return cwd ? ["global", "project"] : ["global"]
}

export const SCOPE_LABEL: Record<InstallScope, string> = { global: "All sessions", project: "This project" }
