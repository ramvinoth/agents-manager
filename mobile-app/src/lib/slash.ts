/**
 * Slash-command autocomplete matching. Pure so it is unit-testable in 0.1s —
 * mirrors the ranking the web composer uses (prefix matches first, then
 * substring, alphabetical within each group).
 */
export type Cmd = { name: string; description?: string; source?: string }

/** The partial command being typed, or null when the composer isn't in "/" mode. */
export function slashTerm(text: string): string | null {
  const m = text.match(/^\/([\w:.-]*)$/)
  return m ? m[1].toLowerCase() : null
}

export function matchCommands(term: string | null, all: Cmd[], limit = 8): Cmd[] {
  if (term === null) return []
  const t = term.toLowerCase()
  return all
    .filter((c) => c.name.toLowerCase().includes(t))
    .sort((a, b) => {
      const as = a.name.toLowerCase().startsWith(t) ? 0 : 1
      const bs = b.name.toLowerCase().startsWith(t) ? 0 : 1
      return as - bs || a.name.localeCompare(b.name)
    })
    .slice(0, limit)
}
