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

export type LayoutNode = { key: string; x: number; y: number; degree: number }

/** A deterministic force layout (no dependency): nodes start on a circle and
 *  settle under pairwise repulsion, spring edges and a pull to the centre.
 *  `keys` are node ids ("n12") or ghost keys ("g:title"); O(n²) per step,
 *  fine for the few hundred notes a project holds. Returns positions in
 *  roughly [-1, 1]. */
export function layoutGraph(keys: string[], links: [string, string][], steps = 220): LayoutNode[] {
  const n = keys.length
  const at = new Map(keys.map((k, i) => [k, i]))
  const x = keys.map((_, i) => Math.cos((2 * Math.PI * i) / Math.max(n, 1)))
  const y = keys.map((_, i) => Math.sin((2 * Math.PI * i) / Math.max(n, 1)))
  const deg = new Array(n).fill(0)
  const springs = links.map(([a, b]) => [at.get(a), at.get(b)])
    .filter((p): p is [number, number] => p[0] !== undefined && p[1] !== undefined && p[0] !== p[1])
  for (const [a, b] of springs) { deg[a]++; deg[b]++ }
  const k = 1.2 / Math.sqrt(Math.max(n, 1))   // ideal edge length
  for (let s = 0; s < steps; s++) {
    const t = 0.1 * (1 - s / steps) + 0.005  // cooling step size
    const dx = new Array(n).fill(0), dy = new Array(n).fill(0)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = x[i] - x[j], ey = y[i] - y[j]
        let d2 = ex * ex + ey * ey
        if (d2 < 1e-9) { ex = 1e-3 * (i - j); ey = 1e-3; d2 = ex * ex + ey * ey }
        const f = (k * k) / d2
        dx[i] += ex * f; dy[i] += ey * f; dx[j] -= ex * f; dy[j] -= ey * f
      }
    }
    for (const [a, b] of springs) {
      const ex = x[a] - x[b], ey = y[a] - y[b]
      const d = Math.sqrt(ex * ex + ey * ey) || 1e-6
      const f = d / k
      dx[a] -= ex * f; dy[a] -= ey * f; dx[b] += ex * f; dy[b] += ey * f
    }
    for (let i = 0; i < n; i++) {
      dx[i] -= x[i] * 0.5; dy[i] -= y[i] * 0.5   // gravity keeps islands on screen
      const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1
      const step = Math.min(d, t)
      x[i] += (dx[i] / d) * step; y[i] += (dy[i] / d) * step
    }
  }
  const span = Math.max(1e-6, ...x.map(Math.abs), ...y.map(Math.abs))
  return keys.map((key, i) => ({ key, x: x[i] / span, y: y[i] / span, degree: deg[i] }))
}
