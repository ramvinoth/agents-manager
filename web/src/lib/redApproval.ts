import { api } from "./api"

/** Decide an org (Red) approval — the ONE resolve call the decision cockpit
 *  and the asking chat share (card 223). /api/org/approvals/resolve keeps the
 *  separation of duties server-side (an agent cannot resolve its own ask) and
 *  the Inbox row's open state is derived from it, so deciding here clears it.
 *  Resolves when decided — 404 (decided elsewhere, or gone) counts as decided;
 *  throws the server's words otherwise, and when an approval ran but the
 *  action itself failed. */
export async function resolveRed(id: string | undefined, decision: "approved" | "denied"): Promise<void> {
  try {
    const r = await api.orgResolveApproval(Number(id), decision)
    if (decision === "approved" && r.result?.error) throw new Error(`Approved, but it failed: ${r.result.error}`)
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e
  }
}
