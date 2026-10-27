/** Mirror of web/src/lib/providerModels.ts (keep the two in step). */
/**
 * The connection editor's model table. A provider is a CONNECTION (endpoint +
 * key) that serves many models; each model has its own context window. The
 * endpoint reports it where it can (discovered) and the owner may override it.
 * Pure — wired by ProvidersScreen and tested in providerModels.test.ts.
 */
export type ModelRow = {
  id: string
  /** Effective window: override, else discovered, else 0 (unknown). */
  contextWindow: number
  source: "override" | "discovered" | ""
  discovered: number
  override: number
  maxOutput: number
}

/** A row in the editor: what the endpoint said + what the owner typed. */
export type EditRow = { id: string; discovered: number; maxOutput: number; override: string }

export type DiscoveredChoice = { id: string; contextWindow?: number; maxOutput?: number }

export function editRows(saved: ModelRow[] | undefined): EditRow[] {
  return (saved || []).map((r) => ({
    id: r.id,
    discovered: r.discovered || 0,
    maxOutput: r.maxOutput || 0,
    override: r.override ? String(r.override) : "",
  }))
}

/** Fold a discovery result into the table. Discovered facts refresh; the
 *  owner's typed overrides and manually added models are never dropped. A saved
 *  connection's discovery reports the EFFECTIVE window, so a row with an
 *  override keeps its previous discovered value rather than echoing the override. */
export function mergeDiscovered(rows: EditRow[], choices: DiscoveredChoice[]): EditRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const c of choices) {
    const prev = byId.get(c.id)
    const reported = c.contextWindow || 0
    const discovered = prev?.override && String(reported) === prev.override ? prev.discovered : reported
    byId.set(c.id, { id: c.id, override: prev?.override || "", discovered, maxOutput: c.maxOutput || prev?.maxOutput || 0 })
  }
  return [...byId.values()]
}

/** Default model first, then alphabetical — the same order the server returns. */
export function sortRows(rows: EditRow[], defaultModel: string): EditRow[] {
  return [...rows].sort((a, b) => Number(b.id === defaultModel) - Number(a.id === defaultModel) || a.id.localeCompare(b.id))
}

export function effectiveWindow(r: EditRow): { tokens: number; source: ModelRow["source"] } {
  const o = parseTokens(r.override)
  if (o) return { tokens: o, source: "override" }
  return r.discovered ? { tokens: r.discovered, source: "discovered" } : { tokens: 0, source: "" }
}

/** "242000", "242k", "1m", "128,000" → tokens; anything else → 0. */
export function parseTokens(text: string): number {
  const m = text.trim().toLowerCase().replace(/[,_\s]/g, "").match(/^(\d+(?:\.\d+)?)([km]?)$/)
  if (!m) return 0
  const n = Math.round(parseFloat(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1))
  return n > 0 && n < 1e8 ? n : 0
}

export function overrideError(text: string): string {
  return text.trim() && !parseTokens(text) ? "Use a token count like 128000, 128k or 1m" : ""
}

/** The full override map the server stores (it replaces the previous one). */
export function overridesPayload(rows: EditRow[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows) {
    const n = parseTokens(r.override)
    if (n) out[r.id] = n
  }
  return out
}

/** 242000 → "242K", 1048576 → "1M", 0 → "—". */
export function formatTokens(n: number): string {
  if (!n) return "—"
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`
  return String(n)
}

/** One plain sentence about a model's context window for its row. */
export function windowLabel(eff: { tokens: number; source: ModelRow["source"] }): string {
  if (!eff.tokens) return "Context window unknown — type it if you know it"
  return `${formatTokens(eff.tokens)} context · ${eff.source === "override" ? "set by you" : "reported by the endpoint"}`
}

