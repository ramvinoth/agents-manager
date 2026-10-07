// One place that turns a failed API call into a sentence a person can act on.
// api/client.ts#req throws Error(message) with `.status`; the message is either
// the server's own `{error}` text (authored for users — e.g. "Not a directory")
// or a bare "HTTP 404" fallback / a fetch transport error, which must never
// reach the screen as-is.

type ApiError = { status?: number; message?: string }

const TRANSPORT = /network request failed|failed to fetch|timed? ?out|aborted/i

/** The request never reached the server (no HTTP status came back): the phone
 *  is offline, or the server/relay is down. The one test for "unreachable". */
export function isTransportError(error: unknown): boolean {
  const e = (error ?? {}) as ApiError
  return !e.status && TRANSPORT.test((e.message || "").trim())
}

/** `what` is the thing that failed, e.g. "this folder", "your chats"; `verb`
 *  is what was being done to it ("load" by default, "send", "save"…). */
export function userError(error: unknown, what: string, verb = "load"): string {
  const e = (error ?? {}) as ApiError
  const msg = (e.message || "").trim()
  if (e.status === 401) return "Your session expired. Sign in again."
  if (e.status === 403) return msg && !/^HTTP \d+$/.test(msg) ? msg : `You don't have access to ${what}.`
  if (e.status === 404 && /^HTTP 404$/.test(msg)) return `This server doesn't support ${what} yet. Update Harman on the server.`
  if (isTransportError(e)) return "Can't reach the server. Check your connection and try again."
  if (msg === "No server configured") return "No server set up yet. Add one in Profile."
  if (!msg || /^HTTP \d+$/.test(msg)) return `Couldn't ${verb} ${what}. Try again.`
  return msg
}
