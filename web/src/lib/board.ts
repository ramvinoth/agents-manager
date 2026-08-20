/**
 * board.ts — pure Kanban board logic. Mirrors the server's viewer/orglogic.py so
 * the client filters/orders/positions cards identically: one canonical `cards`
 * list → any filtered VIEW, columns rendered by position, and fractional indexing
 * so a drag computes a new `position` locally (then POSTs card_move) without
 * renumbering a whole column. Pure + unit-tested (no React imports).
 *
 * Card / BoardColumn / CardFilter are the server contract from ./types.
 */
import type { Card, BoardColumn, CardFilter } from "./types"
export type { Card, BoardColumn, CardFilter }

function pos(c: { position?: number | null }): number {
  const v = c.position
  return typeof v === "number" && isFinite(v) ? v : 0
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
 * "Unsorted" column (id 0) only if such cards exist — so nothing silently vanishes.
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
    const synthetic: BoardColumn = { id: 0, project_id: 0, name: "Unsorted", position: -1 }
    out.unshift({ column: synthetic, cards: orderColumn(orphans) })
  }
  return out
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
