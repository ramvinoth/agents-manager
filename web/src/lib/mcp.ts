/**
 * lib/mcp.ts — the shape of an MCP probe result, and how to say it in the UI.
 *
 * Kept out of the component so the "what does this state mean" decisions are in
 * one readable place: the panel's whole point is to stop implying a server is
 * healthy when nobody has checked, so the mapping from state to words matters
 * as much as the fetch does.
 */

/** Backend states. `unknown` is the client's word for "nobody has tested this
 *  yet" — the server never sends it, because it never guesses. */
export type McpState = "unknown" | "ok" | "auth" | "failed"

export interface McpTool {
  name: string
  description: string
}

export interface ProbeResult {
  name: string
  transport: string
  state: Exclude<McpState, "unknown">
  error: string
  /** Secondary text: stderr tail for a failure, the OAuth metadata URL for auth. */
  detail: string
  tools: McpTool[]
  server: { name?: string; version?: string }
  elapsed_ms: number
}

/** What the panel holds per server: nothing yet, in flight, or an answer. */
export type ProbeEntry = { running: true } | ProbeResult

export function isRunning(e: ProbeEntry | undefined): e is { running: true } {
  return !!e && (e as { running?: true }).running === true
}

export function resultOf(e: ProbeEntry | undefined): ProbeResult | null {
  return e && !isRunning(e) ? e : null
}

export function stateOf(e: ProbeEntry | undefined): McpState {
  const r = resultOf(e)
  return r ? r.state : "unknown"
}

/**
 * The status line for a row. Deliberately never says "connected" for a server
 * that hasn't been probed — "Not tested" is the honest default, and the whole
 * reason this feature exists.
 */
export function stateLabel(e: ProbeEntry | undefined): string {
  if (isRunning(e)) return "Testing…"
  const r = resultOf(e)
  if (!r) return "Not tested"
  if (r.state === "ok") {
    const n = r.tools.length
    return `Connected · ${n} tool${n === 1 ? "" : "s"}`
  }
  if (r.state === "auth") return "Needs authentication"
  return "Failed"
}

/** Tailwind text colour per state. Amber for auth, not red: the server is up
 *  and the config is right — the fix is a login, not an edit. */
export function stateTone(e: ProbeEntry | undefined): string {
  if (isRunning(e)) return "text-muted-foreground"
  switch (stateOf(e)) {
    case "ok":
      return "text-emerald-600 dark:text-emerald-500"
    case "auth":
      return "text-amber-600 dark:text-amber-500"
    case "failed":
      return "text-destructive"
    default:
      return "text-muted-foreground"
  }
}

/** Matching dot colour (bg-*), so the row scans before it is read. */
export function stateDot(e: ProbeEntry | undefined): string {
  if (isRunning(e)) return "bg-muted-foreground/40"
  switch (stateOf(e)) {
    case "ok":
      return "bg-emerald-500"
    case "auth":
      return "bg-amber-500"
    case "failed":
      return "bg-destructive"
    default:
      return "bg-muted-foreground/30"
  }
}

/** "Phoenix 1.0.0 · 750ms" — the provenance line under a successful probe. */
export function serverSummary(r: ProbeResult): string {
  const bits: string[] = []
  if (r.server?.name) bits.push([r.server.name, r.server.version].filter(Boolean).join(" "))
  bits.push(`${r.elapsed_ms}ms`)
  return bits.join(" · ")
}
