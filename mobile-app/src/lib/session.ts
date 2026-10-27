/** A chat that was just started but whose transcript may not exist yet: the
 *  Thread opens on it at once and resolves the path itself, so the owner
 *  watches it start instead of waiting on a spinner elsewhere. */
export type StartingChat = { session: string; message: string }

/** One /api/resolve read for the new session (bound by the caller, so this stays pure). */
type Lookup = () => Promise<{ found: boolean; path?: string; running?: boolean }>

/**
 * Resolve a freshly-started session id to its transcript path.
 *
 * Claude writes the JSONL only once the CLI is up — loading MCP servers can
 * take 30s or more — so the path isn't known when /api/new-session returns.
 * Poll /api/resolve for as long as the run is alive (a fixed 20s window gave
 * up on healthy chats). Returns null when the run ended without a transcript,
 * after `maxTries`, or once `stop()` says the caller has gone.
 */
export async function resolveSessionPath(
  lookup: Lookup,
  { stop = () => false, intervalMs = 1000, maxTries = 180 }: { stop?: () => boolean; intervalMs?: number; maxTries?: number } = {},
): Promise<string | null> {
  let ended = 0
  for (let i = 0; i < maxTries; i++) {
    await new Promise((r) => setTimeout(r, intervalMs))
    if (stop()) return null
    try {
      const res = await lookup()
      if (res.found && res.path) return res.path
      // Not running and still no file: the run died before writing one. A few
      // grace ticks cover a run that finished between the two reads.
      if (!res.running && ++ended >= 5) return null
    } catch {
      /* transient; retry */
    }
  }
  return null
}
