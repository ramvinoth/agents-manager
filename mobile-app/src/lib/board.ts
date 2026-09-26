/**
 * board.ts — pure Kanban board logic for the org/empire UI. Mirrors the server's
 * viewer/orglogic.py so the client filters/orders/positions cards identically:
 * one canonical `cards` list → any filtered VIEW, columns rendered by position,
 * and fractional indexing so a drag computes a new `position` locally (then POSTs
 * card_move) without renumbering a whole column. Pure + unit-tested (no RN imports).
 *
 * Card / BoardColumn / CardFilter are defined once in ../api/client (the server
 * contract). We import the types (erased at runtime by --experimental-strip-types,
 * so the pure node test never loads the RN client) and re-export for convenience —
 * single source of truth, no duplicate type.
 */
import type { Card, BoardColumn, CardFilter } from "../api/client"
export type { Card, BoardColumn, CardFilter }

function pos(c: { position?: number | null }): number {
  const v = c.position
  return typeof v === "number" && isFinite(v) ? v : 0
}

/** Mobile board entries require a session or explicit project; never widen a malformed filter. */
export function boardScopeFilter(input: CardFilter = {}): CardFilter | null {
  const { session, project, assignee } = input
  if (session !== undefined && (typeof session !== "string" || !session.trim())) return null
  if (project !== undefined && (!Number.isSafeInteger(project) || project <= 0)) return null
  if (assignee !== undefined && (!Number.isSafeInteger(assignee) || assignee <= 0)) return null
  if (session === undefined && project === undefined) return null
  return { session, project, assignee }
}

/** Cards matching every provided filter (AND). One board → a session/project/employee view. */
export function filterCards(cards: Card[], f: CardFilter = {}): Card[] {
  return cards.filter((c) => {
    if (f.session !== undefined && c.session_id !== f.session) return false
    if (f.project !== undefined && c.project_id !== f.project) return false
    if (f.assignee !== undefined && c.assignee !== f.assignee) return false
    return true
  })
}

/** Cards sorted by fractional `position` ascending; stable for equal positions. */
export function orderColumn(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => pos(a) - pos(b))
}

/**
 * groupByColumn — split the (already filtered) cards into the board's columns, each
 * ordered by position. Columns come back in their own `position` order. Cards whose
 * column_id matches no column (or is null) are bucketed under a synthetic leading
 * "unassigned" column id 0 only if such cards exist — so nothing silently vanishes.
 */
export function groupByColumn(
  cards: Card[],
  columns: BoardColumn[]
): { column: BoardColumn; cards: Card[] }[] {
  const cols = [...columns].sort((a, b) => a.position - b.position)
  const byId = new Map<number, Card[]>()
  for (const col of cols) byId.set(col.id, [])
  const orphans: Card[] = []
  for (const card of cards) {
    const bucket = card.column_id != null ? byId.get(card.column_id) : undefined
    if (bucket) bucket.push(card)
    else orphans.push(card)
  }
  const out = cols.map((col) => ({ column: col, cards: orderColumn(byId.get(col.id) || []) }))
  if (orphans.length) {
    out.unshift({ column: { id: 0, name: "Unsorted", position: -1 }, cards: orderColumn(orphans) })
  }
  return out
}

/**
 * A principal actor string (viewer/server.py: `user:<name>` for a human,
 * `session:<title>` / `employee:<name>` for an agent) rendered for a person:
 * the name alone, plus whether it was a human, an agent, or the reader.
 * "employee:?" is the server's marker for an unlinked agent, never a name.
 *
 * Ported verbatim from web/src/lib/board.ts so both clients label the same
 * author identically — one rule, two renderings, no third copy in a screen.
 */
export type ActorKind = "you" | "human" | "agent" | "unknown"
export function formatActor(actor: string | null | undefined, selfUsername?: string): { name: string; kind: ActorKind } {
  const raw = (actor || "").trim()
  const sep = raw.indexOf(":")
  if (sep < 0) return raw ? { name: raw, kind: "unknown" } : { name: "Unknown", kind: "unknown" }
  const prefix = raw.slice(0, sep)
  const name = raw.slice(sep + 1).trim()
  if (prefix === "user") {
    return name ? { name, kind: name === selfUsername ? "you" : "human" } : { name: "Unknown user", kind: "unknown" }
  }
  if (prefix === "session" || prefix === "employee") {
    return name && name !== "?" ? { name, kind: "agent" } : { name: "Unlinked agent", kind: "agent" }
  }
  return { name: raw, kind: "unknown" }
}

/**
 * nextPosition — the fractional rank for a card dropped at `index` within a column
 * that is ALREADY ordered by position (the card being moved assumed absent). Same
 * rule as server orglogic.next_position so client + server agree:
 *  - empty column → 1
 *  - top (index<=0)    → first.position - 1
 *  - bottom (index>=n) → last.position + 1
 *  - middle → midpoint of the two straddling cards
 */
export function nextPosition(cardsInColumn: Card[], index: number): number {
  const ordered = orderColumn(cardsInColumn)
  const n = ordered.length
  if (n === 0) return 1
  if (index <= 0) return pos(ordered[0]) - 1
  if (index >= n) return pos(ordered[n - 1]) + 1
  return (pos(ordered[index - 1]) + pos(ordered[index])) / 2
}
