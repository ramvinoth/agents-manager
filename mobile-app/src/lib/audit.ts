// The server owns the safe projection and result meaning. Never accept raw audit rows.
export type AuditResult = "returned" | "queued" | "denied" | "error" | "other"
export type AuditFilter = "all" | AuditResult
export type AuditEntry = {
  id: number
  actor: string
  action: string
  target: { label: string; card_id?: number }
  result: { category: AuditResult; label: string; explanation: string }
  created_at: number | null
}
export type AuditPage = { view: "display-v1"; audit: AuditEntry[]; next_before: number | null }
export const AUDIT_FILTERS: { value: AuditFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "returned", label: "Handler returned" },
  { value: "queued", label: "Queued when recorded" },
  { value: "denied", label: "Denied" },
  { value: "error", label: "Error" },
  { value: "other", label: "Other" },
]
export class AuditUpdateRequired extends Error {
  constructor() { super("Server update required to display the audit log safely.") }
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const positiveID = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0
const text = (v: unknown): v is string => typeof v === "string" && !!v.trim()
const resultCategory = (v: unknown): v is AuditResult => AUDIT_FILTERS.some(f => f.value !== "all" && f.value === v)
const date = (v: unknown): Date | null => {
  if (typeof v !== "number" || !Number.isFinite(v)) return null
  const d = new Date(v * 1000)
  return Number.isFinite(d.getTime()) ? d : null
}

export function parseAuditPage(value: unknown, before?: number): AuditPage {
  if (!record(value) || value.view !== "display-v1") throw new AuditUpdateRequired()
  const invalid = () => new Error("Invalid audit display response.")
  if (!Array.isArray(value.audit) || !(value.next_before === null || positiveID(value.next_before))) throw invalid()
  const audit = value.audit.map((row): AuditEntry => {
    if (!record(row) || !positiveID(row.id) || !text(row.actor) || !text(row.action)
      || !record(row.target) || !text(row.target.label)
      || (row.target.card_id !== undefined && !positiveID(row.target.card_id))
      || !record(row.result) || !text(row.result.label) || !text(row.result.explanation)
      || !resultCategory(row.result.category)) throw invalid()
    // Copy only the display fields. Extra payload fields never enter navigation state.
    return {
      id: row.id, actor: row.actor, action: row.action,
      target: { label: row.target.label, ...(positiveID(row.target.card_id) ? { card_id: row.target.card_id } : {}) },
      result: { category: row.result.category as AuditResult, label: row.result.label, explanation: row.result.explanation },
      created_at: date(row.created_at) ? row.created_at as number : null,
    }
  })
  if (before !== undefined && audit.some(row => row.id >= before)) throw invalid()
  if (value.next_before !== null && (!audit.length || value.next_before !== Math.min(...audit.map(row => row.id)))) throw invalid()
  return { view: "display-v1", audit, next_before: value.next_before }
}

export function auditPath(filter: AuditFilter, before?: number): string {
  return `/api/org/audit?view=display-v1&limit=50&result=${filter}${before === undefined ? "" : `&before=${before}`}`
}

export function auditTime(timestamp: number | null): string {
  return date(timestamp)?.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) ?? "Time unavailable"
}
export function auditTimestamp(timestamp: number | null): string {
  return date(timestamp)?.toLocaleString(undefined, {
    year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset",
  }) ?? "Time unavailable"
}
export type AuditSection = { key: string; title: string; data: AuditEntry[] }
export function groupAuditEntries(rows: AuditEntry[]): AuditSection[] {
  const sections: AuditSection[] = []
  let lastDay = ""
  for (const row of rows) {
    const d = date(row.created_at)
    const day = d ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : "undated"
    // Consecutive grouping preserves ID order even when recorded clocks move backwards.
    if (day !== lastDay) {
      sections.push({ key: `${day}-${row.id}`, title: d ? d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" }) : "Date unavailable", data: [] })
      lastDay = day
    }
    sections[sections.length - 1].data.push(row)
  }
  return sections
}

export function auditError(error: unknown): string {
  if (error instanceof AuditUpdateRequired) return error.message
  const status = record(error) ? error.status : undefined
  if (status === 401) return "Your session has expired. Please sign in again."
  if (status === 403) return "You do not have access to this audit log."
  // HTTP errors can contain arbitrary server text. Never echo it into the safe view.
  return "Could not load the audit log. Please try again."
}
export type AuditLoad = "initial" | "refresh" | "older"
export type AuditState = {
  filter: AuditFilter; rows: AuditEntry[]; nextBefore: number | null
  request: number; loading: AuditLoad | null; loaded: boolean; error: string; olderError: string
}
export const initialAuditState = (): AuditState => ({ filter: "all", rows: [], nextBefore: null, request: 0, loading: null, loaded: false, error: "", olderError: "" })
export type AuditEvent =
  | { type: "begin"; request: number; mode: AuditLoad; filter: AuditFilter }
  | { type: "success"; request: number; page: AuditPage }
  | { type: "failure"; request: number; error: string }

export function auditReducer(state: AuditState, event: AuditEvent): AuditState {
  if (event.type === "begin") {
    const reset = event.filter !== state.filter || event.mode === "initial"
    return { ...state, ...(reset ? { rows: [], nextBefore: null, loaded: false } : {}), filter: event.filter, request: event.request, loading: event.mode, error: "", olderError: "" }
  }
  if (event.request !== state.request || !state.loading) return state
  if (event.type === "failure") return { ...state, loading: null, ...(state.loading === "older" ? { olderError: event.error } : { error: event.error }) }
  const rows = state.loading === "older" ? [...state.rows, ...event.page.audit] : event.page.audit
  const unique = new Map<number, AuditEntry>()
  for (const row of rows) if (!unique.has(row.id)) unique.set(row.id, row)
  return { ...state, rows: [...unique.values()].sort((a, b) => b.id - a.id), nextBefore: event.page.next_before, loaded: true, loading: null, error: "", olderError: "" }
}
