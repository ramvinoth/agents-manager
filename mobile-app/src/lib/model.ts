/**
 * Normalise the composer's model selection before it hits the API.
 *
 * The picker uses "default" as its sentinel for "let the CLI pick" and the app
 * persists that literal string. But the server passes any non-empty model
 * straight to `claude --model <m>`, so sending "default" runs
 * `claude --model default` — an invalid model id. (The web UI avoids this by
 * storing the Default choice as "".) So map the sentinel — and blank/whitespace
 * — to undefined, which omits `--model` entirely and uses the CLI default.
 *
 * Real model aliases ("opus", "sonnet", "haiku") and full ids pass through
 * unchanged. If your API key can't use one (e.g. Opus), that's a key/plan
 * limit, not this bug.
 */
export function normModel(model: string | undefined): string | undefined {
  const m = (model || "").trim()
  if (!m || m === "default") return undefined
  return m
}
