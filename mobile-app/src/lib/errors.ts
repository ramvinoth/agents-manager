// One place that turns a failed API call into a sentence a person can act on.
// api/client.ts#req throws Error(message) with `.status`; the message is either
// the server's own `{error}` text (authored for users — e.g. "Not a directory")
// or a bare "HTTP 404" fallback / a fetch transport error, which must never
// reach the screen as-is.

type ApiError = { status?: number; message?: string }

const TRANSPORT = /network request failed|failed to fetch|timed? ?out|aborted/i

/** `what` is the thing that failed to load, e.g. "this folder", "your chats". */
export function userError(error: unknown, what: string): string {
  const e = (error ?? {}) as ApiError
  const msg = (e.message || "").trim()
  if (e.status === 401) return "Your session expired. Sign in again."
  if (e.status === 403) return msg && !/^HTTP \d+$/.test(msg) ? msg : `You don't have access to ${what}.`
  if (e.status === 404 && /^HTTP 404$/.test(msg)) return `This server doesn't support ${what} yet. Update Harman on the server.`
  if (!e.status && TRANSPORT.test(msg)) return "Can't reach the server. Check your connection and try again."
  if (msg === "No server configured") return "No server set up yet. Add one in Profile."
  if (!msg || /^HTTP \d+$/.test(msg)) return `Couldn't load ${what}. Try again.`
  return msg
}
