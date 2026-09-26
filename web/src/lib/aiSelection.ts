// The AI selection model — which provider, model, conversation mode and effort
// a session (or every new chat) runs with. The SERVER owns it (viewer/ai.py):
// it validates every save against the live provider library and the host's
// capabilities, and guards concurrent edits with a revision. This module is the
// client's pure half: the shape, equality, the draft transitions, the labels,
// and the one rule for "can this draft be saved" — so the dialog stays wiring.
// Mirrors mobile-app/src/lib/aiSelection.ts; the two must agree on the shape.

export type AIModel = { kind: "default" } | { kind: "id"; id: string } | null
export type AISelection = { provider: string; model: AIModel; convMode: "agent" | "chat"; effort: string }
export type AICapabilities = {
  editable: boolean
  customProviders: boolean
  conversationModes: string[]
  efforts: string[]
  manualModelId: boolean
}
export type AIConfig = {
  revision: number
  /** Defaults scope only: false until the owner has saved defaults once. */
  configured?: boolean
  selection: AISelection
  capabilities: AICapabilities
  /** Server's verdict when the STORED selection no longer validates (a deleted provider…). */
  issue?: string
}
export type ModelDiscovery = {
  models: string[]
  choices: { id: string; label: string }[]
  status: "ok" | "empty" | "unsupported" | "error"
  source: "endpoint" | "runner"
  manualModelId: boolean
  error?: string
}
/** Where a selection lives: a session (by id) or the per-user new-chat defaults. */
export type AIScope = { id?: string; host: string; agent?: string }

export function sameAI(a: AISelection, b: AISelection): boolean {
  return (
    a.provider === b.provider &&
    a.convMode === b.convMode &&
    a.effort === b.effort &&
    a.model?.kind === b.model?.kind &&
    (a.model?.kind !== "id" || (b.model?.kind === "id" && a.model.id === b.model.id))
  )
}

/** Switching provider resets the dependent fields (a model id belongs to one
 *  endpoint) unless the user is switching BACK — then their earlier draft for
 *  that provider is restored, so flipping to compare costs nothing. */
export function switchAIProvider(current: AISelection, provider: string, previous?: AISelection): AISelection {
  if (current.provider === provider) return current
  if (previous?.provider === provider) return { ...previous }
  return { provider, model: { kind: "default" }, convMode: "agent", effort: "" }
}

export function modelLabel(model: AIModel): string {
  if (model === null) return "Model from the request"
  return model.kind === "default" ? "Provider default model" : model.id
}

export function providerLabel(provider: string, providers: { id: string; name: string }[]): string {
  if (!provider) return "Claude (your login)"
  return providers.find((p) => p.id === provider)?.name || `Unavailable connection (${provider})`
}

/** One line for summary rows: "Claude (your login) · medium effort". Omits the
 *  parts that are at their default so the common case reads short. */
export function aiSummary(selection: AISelection, providers: { id: string; name: string }[]): string {
  const parts = [providerLabel(selection.provider, providers)]
  if (selection.model && selection.model.kind === "id") parts.push(selection.model.id)
  if (selection.provider) parts.push(`${selection.convMode} mode`)
  if (selection.effort) parts.push(`${selection.effort} effort`)
  return parts.join(" · ")
}

export function aiError(error: unknown): string {
  const e = error as { status?: number; message?: string }
  if (e?.status === 404 || e?.status === 405) return "Server update required for AI settings."
  if (e?.status === 409) return "These settings changed elsewhere. Your draft is kept; cancel and reopen to load the latest before saving."
  return e?.message || "Could not load or save AI settings. Please retry."
}

/** Why `draft` cannot be saved right now, or null when it can. The server
 *  re-checks all of this (ai.validate); this is the same rule stated up front
 *  so the Save button and the message agree before a round trip. */
export function selectionProblem(
  draft: AISelection,
  caps: AICapabilities | null,
  providers: { id: string }[]
): string | null {
  if (!caps) return null
  if (!caps.editable) return "AI settings cannot be changed for this agent."
  if (draft.provider && !providers.some((p) => p.id === draft.provider))
    return "The selected connection no longer exists. Choose another provider."
  if (draft.provider && !caps.customProviders) return "Custom providers run only on this machine with Claude."
  if (!caps.conversationModes.includes(draft.convMode)) return "That conversation mode is not available here."
  if (!caps.efforts.includes(draft.effort)) return "That effort level is not available for this provider."
  if (draft.model?.kind === "id" && !draft.model.id.trim()) return "Enter a model ID or pick the provider default."
  return null
}

/** The rows of the model list: discovered choices plus the current manual id
 *  when discovery didn't return it (so the selection is always visible),
 *  filtered by the search box. */
export function modelChoices(discovery: ModelDiscovery | null, current: AIModel, search: string): { id: string; label: string }[] {
  const rows = new Map((discovery?.choices || []).map((row) => [row.id, row]))
  if (current?.kind === "id" && !rows.has(current.id))
    rows.set(current.id, { id: current.id, label: `${current.id} (current; not in discovered list)` })
  const q = search.trim().toLowerCase()
  return [...rows.values()]
    .filter((r) => `${r.id} ${r.label}`.toLowerCase().includes(q))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** What the discovery status line should say. */
export function discoveryHint(discovery: ModelDiscovery | null, loading: boolean): string {
  if (loading) return "Loading model choices…"
  if (!discovery) return ""
  if (discovery.status === "error") return discovery.error || "Model discovery failed."
  if (discovery.status === "unsupported") return "This endpoint does not list its models. Use the provider default or enter a model ID."
  if (discovery.status === "empty") return "The endpoint returned no models. Enter a model ID or use the provider default."
  return "A listed model is not a guarantee you have access to run it."
}
