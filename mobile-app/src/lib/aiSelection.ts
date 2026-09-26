/** Server-owned AI configuration. No device-side model catalog or defaults store. */
export type AIModel = { kind: "default" } | { kind: "id"; id: string } | null
export type AISelection = { provider: string; model: AIModel; convMode: "agent" | "chat"; effort: string }
export type AICapabilities = { editable: boolean; customProviders: boolean; conversationModes: string[]; efforts: string[]; manualModelId: boolean }
export type AIConfig = { revision: number; configured?: boolean; selection: AISelection; capabilities: AICapabilities; issue?: string }
export type ModelDiscovery = { models: string[]; choices: { id: string; label: string }[]; status: "ok" | "empty" | "unsupported" | "error"; source: "endpoint" | "runner"; manualModelId: boolean; error?: string }
export type KeyAction = "keep" | "remove" | "replace"
export type ConnectionDraft = { id?: string; baseUrl: string; apiKeyAction: KeyAction; apiKey?: string }

export function sameAI(a: AISelection, b: AISelection): boolean {
  return a.provider === b.provider && a.convMode === b.convMode && a.effort === b.effort &&
    a.model?.kind === b.model?.kind && (a.model?.kind !== "id" || (b.model?.kind === "id" && a.model.id === b.model.id))
}

export function switchAIProvider(current: AISelection, provider: string, previous?: AISelection): AISelection {
  if (current.provider === provider) return current
  if (previous?.provider === provider) return { ...previous }
  return { provider, model: { kind: "default" }, convMode: "agent", effort: "" }
}

export function modelLabel(model: AIModel): string {
  return model === null ? "Legacy request / runner selection" : model.kind === "default" ? "Runner / provider default" : model.id
}

export function aiSummary(selection: AISelection, providers: { id: string; name: string }[]): string {
  const name = selection.provider ? providers.find(p => p.id === selection.provider)?.name || `Unavailable connection (${selection.provider})` : "Built-in"
  return `${name} · ${modelLabel(selection.model)}`
}

export function aiError(error: unknown): string {
  const e = error as { status?: number; message?: string }
  if (e?.status === 404 || e?.status === 405) return "Server update required for AI settings."
  if (e?.status === 409) return "These settings changed elsewhere. Your draft is kept; cancel and reopen to load the latest before saving."
  return e?.message || "Could not load or save AI settings. Please retry."
}

/** Only legacy prefill uses device preferences; never migrate them to defaults. */
export function newChatAI(config: AIConfig, legacyModel: string, templateModel?: string): AISelection {
  if (config.configured) return config.selection
  const model = templateModel || legacyModel
  // A legacy custom preset's own model wins, not a built-in device model.
  return { ...config.selection, model: !config.selection.provider && model && model !== "default" ? { kind: "id", id: model } : { kind: "default" } }
}

export function connectionPayload(draft: ConnectionDraft, originalUrl?: string): ConnectionDraft {
  const baseUrl = draft.baseUrl.trim()
  if (draft.id && originalUrl !== undefined && baseUrl !== originalUrl.trim() && draft.apiKeyAction === "keep") {
    throw new Error("Endpoint changed. Explicitly remove the saved key or enter a replacement before discovering or saving.")
  }
  if (draft.apiKeyAction === "replace" && !draft.apiKey?.trim()) throw new Error("Enter a replacement API key, or choose Keep or Remove.")
  return { id: draft.id || undefined, baseUrl, apiKeyAction: draft.apiKeyAction, ...(draft.apiKeyAction === "replace" ? { apiKey: draft.apiKey!.trim() } : {}) }
}

export function modelChoices(discovery: ModelDiscovery | null, current: AIModel, search: string): { id: string; label: string }[] {
  const rows = new Map((discovery?.choices || []).map(row => [row.id, row]))
  if (current?.kind === "id" && !rows.has(current.id)) rows.set(current.id, { id: current.id, label: `${current.id} (current; not in discovered list)` })
  const q = search.trim().toLowerCase()
  return [...rows.values()].filter(r => `${r.id} ${r.label}`.toLowerCase().includes(q)).sort((a, b) => a.id.localeCompare(b.id))
}
