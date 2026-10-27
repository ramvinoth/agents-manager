// One place that turns a failed request into a sentence a person can act on —
// the web twin of mobile-app/src/lib/errors.ts. api.ts throws Error(message)
// with `.status`; the message is either the server's own `{error}` text
// (authored for people) or a bare "HTTP 500" / browser transport / JSON-parse
// failure, which must never reach the screen as-is.

type ApiError = { status?: number; message?: string }

// Chrome "Failed to fetch", Safari "Load failed", Firefox "NetworkError…".
const TRANSPORT = /failed to fetch|load failed|networkerror|network request failed|timed? ?out|aborted/i
// A proxy/HTML error page parsed as JSON.
const BAD_JSON = /unexpected token|not valid json|json\.parse|unexpected end of json/i

export function isTransportError(error: unknown): boolean {
  const e = (error ?? {}) as ApiError
  return !e.status && TRANSPORT.test((e.message || "").trim())
}

/** `what` is the thing that failed ("this card", "your notes"); `verb` is
 *  what was being done to it ("load" by default, "send", "save"…). */
export function userError(error: unknown, what: string, verb = "load"): string {
  const e = (error ?? {}) as ApiError
  const msg = (typeof error === "string" ? error : e.message || "").trim()
  if (e.status === 401) return "Your sign-in expired. Reload the page and sign in again."
  if (e.status === 403) return msg && !/^HTTP \d+$/.test(msg) ? msg : `You don't have access to ${what}.`
  if (e.status === 404 && /^HTTP 404$/.test(msg)) return `This server doesn't support ${what} yet. Update Manager on the server.`
  if (isTransportError(e)) return "Can't reach the Manager server. Check your connection and try again."
  if (!msg || /^HTTP \d+$/.test(msg) || BAD_JSON.test(msg) || msg === "[object Object]") return `Couldn't ${verb} ${what}. Try again.`
  return msg
}
