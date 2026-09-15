import { api } from "../api/client"

/**
 * Resolve a freshly-started session id to its transcript path.
 *
 * Claude creates the JSONL asynchronously after /api/new-session returns, so
 * the path isn't known yet. Poll /api/resolve until it appears (or give up
 * after ~20s). Returns the path, or null if it never materialised.
 */
export async function resolveSessionPath(sessionId: string, host: string): Promise<string | null> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    try {
      const res = await api.resolve(sessionId, host)
      if (res.found && res.path) return res.path
    } catch {
      /* retry */
    }
  }
  return null
}
