// "#" file picker in the composer: typing #comp at the caret searches the
// project's files and folders; choosing one swaps the #word for @path, which
// Claude Code inlines (a file's contents, a folder's listing) when it reads
// the prompt. Same rules as the web composer (web/src/lib/fileMention.ts).

export interface HashTerm {
  start: number // index of the "#"
  query: string // what follows it, up to the caret
}

// The #word that ends at `caret`, or null. The "#" must start a word and be
// followed by at least one non-space character, so a markdown "# Title" or a
// lone "#" never opens the picker; all-digit words ("card #203") are
// references, not file searches. A caret past the end (a stale selection
// event from before the text shrank) counts as the end, never as an offset.
export function hashTerm(text: string, caret: number): HashTerm | null {
  caret = Math.min(caret, text.length)
  const m = text.slice(0, caret).match(/(^|\s)#([^\s#]+)$/)
  if (!m || /^\d+$/.test(m[2])) return null
  return { start: caret - m[2].length - 1, query: m[2] }
}

// The mention Claude Code understands: @path, quoted when it has spaces.
export function mentionFor(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`
}

// Replace the #word at [term.start, caret) with the mention and a trailing
// space; returns the new text and where the caret goes.
export function applyMention(
  text: string,
  term: HashTerm,
  caret: number,
  path: string
): { text: string; caret: number } {
  const ins = mentionFor(path) + " "
  const rest = text.slice(caret).replace(/^ /, "")
  return { text: text.slice(0, term.start) + ins + rest, caret: term.start + ins.length }
}
