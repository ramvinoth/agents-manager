/**
 * Reading an ExitPlanMode tool call: its plan text, and whether it was decided.
 *
 * Whether a plan was decided is NOT stored anywhere — it is derived from the
 * transcript record itself. A tool_use with `result == null` is still awaiting a
 * decision; once the user approves or asks for changes, the CLI writes a
 * tool_result and that block is, permanently, history. The server can't answer
 * this: it DELETES the pending_plans row on resolve (viewer/db.py
 * pending_plan_delete), so it only ever knows "is something pending right now".
 *
 * Which of the two decisions it was IS a string heuristic on CLI output, and is
 * deliberately confined to this file. Verified against 12 real ExitPlanMode
 * results in ~/.claude/projects/-Users-rponnarasu-srv-tim-fvg-stock-scanner/
 * dbd49b66-1f22-477e-870f-72a84fe4fe57.jsonl: every approved one begins
 * "User has approved your plan." A declined one is the user's own feedback text
 * (viewer/engine.py, _await_plan_decision). If the CLI ever rewords its message
 * we fall back to the neutral "decided" — the badge degrades, the collapse does
 * not. Same class of heuristic as ANSWER_PREFIX in thread.ts.
 *
 * DUPLICATED in web/src/lib/plan.ts, deliberately: the two apps share no build.
 * Keep them in sync BY HAND. Both copies are unit-tested — change one, change
 * the other, run both suites.
 */

export type PlanState = "pending" | "approved" | "revised" | "decided"

const APPROVED_PREFIX = "User has approved your plan"

/** The plan markdown from an ExitPlanMode input (object, or JSON string). */
export function planText(input: unknown): string {
  let obj: any = input
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj)
    } catch {
      return obj // a bare string is the plan itself
    }
  }
  return typeof obj?.plan === "string" ? obj.plan : ""
}

/** Flatten a tool_result into plain text: string, or Anthropic's content parts. */
function resultText(result: unknown): string {
  if (result == null) return ""
  if (typeof result === "string") return result
  if (Array.isArray(result)) {
    return result
      .map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
      .join("")
  }
  const o = result as any
  if (typeof o?.text === "string") return o.text
  if (typeof o?.content === "string") return o.content
  if (Array.isArray(o?.content)) return resultText(o.content)
  return ""
}

/** What became of a proposed plan, from its tool_result. */
export function planDecision(result: unknown): PlanState {
  if (result == null) return "pending"
  const text = resultText(result).trim()
  if (!text) return "decided"
  if (text.startsWith(APPROVED_PREFIX)) return "approved"
  return "revised"
}

/** Header suffix for a plan card — "" while pending. */
export function planStateLabel(state: PlanState): string {
  if (state === "approved") return "approved"
  if (state === "revised") return "changes requested"
  if (state === "decided") return "decided"
  return ""
}
