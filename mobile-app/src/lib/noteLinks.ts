/**
 * noteLinks.ts — the client half of linked notes (server: viewer/notelinks.py).
 *
 * The server owns parsing and every tie-break: it ships the graph and the
 * title `index` a [[link]] resolves through. The client mirrors only `norm`,
 * and adds what is purely interactive — [[ autocomplete, link insertion, tag
 * filtering and the graph layout. Pure (no DOM/RN): unit-tested under node,
 * and kept identical in web/ and mobile-app/.
 */

export type GraphNode = {
  id: number; title: string; kind: string; project_id: number | null
  archived: boolean; pinned: boolean; tags: string[]; updated_at: number
}
export type GraphEdge = { source: number; target: number; heading: string; context: string }
export type GraphGhost = { title: string; project_id: number | null; from: number[] }
export type NoteGraph = {
  nodes: GraphNode[]; edges: GraphEdge[]; ghosts: GraphGhost[]
  tags: { tag: string; count: number }[]
  /** project id ("" = no project) → norm(title) → note id */
  index: Record<string, Record<string, number>>
}

/** How a link names a note: case-insensitive, whitespace-collapsed (server `norm`). */
export function norm(title: string): string {
  return String(title || "").split(/\s+/).filter(Boolean).join(" ").toLowerCase()
}

/** The note a [[target]] written in `projectId` resolves to, else null (a ghost). */
export function resolveLink(g: Pick<NoteGraph, "index"> | null, projectId: number | null, target: string): number | null {
  const id = g?.index[projectId == null ? "" : String(projectId)]?.[norm(target)]
  return id ?? null
}

/** An unfinished `[[query` right before the caret, or null. The query may not
 *  span a line, a `]`, or reach past `|`/`#` (then the title is already chosen). */
export function openLinkQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const start = before.lastIndexOf("[[")
  if (start < 0) return null
  const query = before.slice(start + 2)
  if (/[\]\n|#[]/.test(query)) return null
  return { start, query }
}

/** Titles to offer for `query`: prefix matches first, then word-start, then
 *  anywhere; shorter titles first within a rank. `exclude` = the open note. */
export function suggestTitles(titles: string[], query: string, limit = 8, exclude = ""): string[] {
  const q = norm(query), ex = norm(exclude)
  const seen = new Set<string>()
  const ranked: { t: string; r: number }[] = []
  for (const t of titles) {
    const k = norm(t)
    if (!k || k === ex || seen.has(k)) continue
    seen.add(k)
    const r = !q ? 0 : k.startsWith(q) ? 0 : k.includes(" " + q) ? 1 : k.includes(q) ? 2 : -1
    if (r >= 0) ranked.push({ t: t.trim(), r })
  }
  ranked.sort((a, b) => a.r - b.r || a.t.length - b.t.length || a.t.localeCompare(b.t))
  return ranked.slice(0, limit).map((x) => x.t)
}

/** Replace the open `[[query` at `start..caret` with a finished `[[title]]`,
 *  swallowing a `]]` the editor already auto-typed after the caret. */
export function completeLink(text: string, start: number, caret: number, title: string): { text: string; caret: number } {
  const after = text.slice(caret).startsWith("]]") ? text.slice(caret + 2) : text.slice(caret)
  const link = `[[${title}]]`
  return { text: text.slice(0, start) + link + after, caret: start + link.length }
}

/** Notes carrying every tag in `tags` (graph node tags are lower-case). */
export function filterByTags<T extends { id: number }>(notes: T[], g: NoteGraph | null, tags: string[]): T[] {
  if (!tags.length || !g) return notes
  const byId = new Map(g.nodes.map((n) => [n.id, n.tags]))
  return notes.filter((n) => tags.every((t) => byId.get(n.id)?.includes(t)))
}

/** One note's neighbourhood from the project graph: who links here (with the
 *  line they link from), what it links to, and its links to notes not written yet. */
export function neighbours(g: NoteGraph | null, id: number) {
  if (!g) return { backlinks: [], links: [], ghosts: [] }
  const title = new Map(g.nodes.map((n) => [n.id, n.title]))
  return {
    backlinks: g.edges.filter((e) => e.target === id && e.source !== id)
      .map((e) => ({ ...e, title: title.get(e.source) || "" })),
    links: g.edges.filter((e) => e.source === id && e.target !== id)
      .map((e) => ({ ...e, title: title.get(e.target) || "" })),
    ghosts: g.ghosts.filter((x) => x.from.includes(id)).map((x) => x.title),
  }
}
