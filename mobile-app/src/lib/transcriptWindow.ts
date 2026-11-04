// The slice of a session transcript the thread has loaded: its lines plus the
// byte range [start, end) they cover in the .jsonl file. Older history pages in
// by asking for the lines just before `start` (the server caps a tail read at
// 5000 lines, so growing a tail window can never reach further back).
export type TranscriptWindow = { path?: string; lines: string[]; start: number; end: number }

export type TranscriptPage = { lines: string[]; start: number; end: number }

export const EMPTY_WINDOW: TranscriptWindow = { lines: [], start: 0, end: 0 }

// True while the file holds history above the loaded window for this chat.
export const hasOlder = (w: TranscriptWindow, path?: string): boolean =>
  !!path && w.path === path && w.start > 0

// Prepend a page read with `before = cur.start`. Returns null when the page no
// longer joins the window (the chat changed, or a reload replaced the window
// while the request was in flight), so a stale page is dropped, not spliced in.
export function prependOlder(cur: TranscriptWindow, path: string, page: TranscriptPage): TranscriptWindow | null {
  if (cur.path !== path || page.end !== cur.start) return null
  return { ...cur, lines: [...page.lines, ...cur.lines], start: page.start }
}
