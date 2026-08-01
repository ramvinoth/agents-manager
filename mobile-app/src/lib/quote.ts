/**
 * Quoting a message into the composer, WhatsApp-style. Pure so the truncation
 * and escaping rules are unit-tested — a badly quoted message silently changes
 * what the agent is asked to do.
 */

/** Short preview shown in the composer's reply bar. */
export function quotePreview(text: string, max = 90): string {
  const one = (text || "").replace(/\s+/g, " ").trim()
  return one.length > max ? one.slice(0, max - 1) + "…" : one
}

/**
 * The text actually sent. The quote goes in double quotes on its own line so the
 * agent can see exactly what is being referred to, then the user's reply follows.
 */
export function buildReply(quoted: string, reply: string, max = 500): string {
  const q = (quoted || "").replace(/\s+/g, " ").trim()
  if (!q) return reply
  const clipped = q.length > max ? q.slice(0, max - 1) + "…" : q
  // Collapse any inner double quotes so the block stays unambiguous.
  const safe = clipped.replace(/"/g, "'")
  return `Replying to: "${safe}"\n\n${reply}`
}
