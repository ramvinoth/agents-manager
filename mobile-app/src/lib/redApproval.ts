/**
 * Deciding an org (Red) approval — the ONE rule the decision cockpit and the
 * asking chat share (card 223). The resolve route (/api/org/approvals/resolve)
 * keeps separation of duties server-side (an agent cannot resolve its own
 * ask), and the Inbox row's open state is derived from it, so deciding here
 * clears the Inbox too. Pure: the API call is injected.
 */
import type { RedAsk } from "../api/client"

export type RedResolution = "approved" | "denied"
type Resolver = (body: { id: number; resolution: RedResolution }) => Promise<{ result?: { error?: string } }>

/** Resolves when the approval is decided — a 404 (decided on another surface,
 *  or gone) counts as decided. Throws the server's words otherwise, and when
 *  an approval went through but the action itself failed (the reader must
 *  know it did not happen). */
export async function resolveRed(resolve: Resolver, id: string | undefined, resolution: RedResolution): Promise<void> {
  const n = Number(id)
  if (!id || !Number.isInteger(n) || n <= 0) throw new Error("This approval has no id. Decide it from the Inbox.")
  try {
    const r = await resolve({ id: n, resolution })
    if (resolution === "approved" && r?.result?.error) throw new Error(`Approved, but it failed: ${r.result.error}`)
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e
  }
}

/** The chat's open asks once one is decided — what remains on screen until
 *  the next status read confirms it. */
export function withoutRed(asks: RedAsk[], id: string | undefined): RedAsk[] {
  return asks.filter((a) => a.id !== id)
}
