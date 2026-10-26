/**
 * Grouping a transcript into "exchanges": one item per run of consecutive
 * assistant turns, so a reply's tool calls fold under ONE message instead of
 * a bubble per API turn.
 *
 * Mirrors mobile-app/src/lib/thread.ts groupThread (the apps share no build, so
 * the rule is kept in sync by hand): the trailing run of text blocks is the
 * answer, everything before it is the "steps" (tool calls + narration). An
 * unanswered AskUserQuestion and every ExitPlanMode are pulled out of the steps
 * so the agent's question or plan is never hidden behind a collapsed toggle.
 */
import type { AssistantTurn, Block, SystemTurn, ToolUseBlock, Turn, UserTurn } from "./types"

export interface Exchange {
  type: "exchange"
  /** The first member turn's domId — the exchange's own anchor. */
  domId: string
  /** Every member turn's domId, so a search hit on any of them lands here. */
  memberIds: string[]
  /** The model of the latest member turn. */
  model?: string
  steps: Block[]
  /** Question / plan cards surfaced out of the steps, in transcript order. */
  surfaced: ToolUseBlock[]
  answer: Block[]
}
export type ThreadItem = UserTurn | SystemTurn | Exchange

const isSurfaced = (b: Block): b is ToolUseBlock =>
  b.type === "tool_use" && (b.name === "ExitPlanMode" || (b.name === "AskUserQuestion" && b.result == null))

function toExchange(members: AssistantTurn[]): Exchange {
  const blocks = members.flatMap((t) => t.blocks)
  let cut = blocks.length
  while (cut > 0 && blocks[cut - 1].type === "text") cut--
  const before = blocks.slice(0, cut)
  return {
    type: "exchange",
    domId: members[0].domId,
    memberIds: members.map((t) => t.domId),
    model: [...members].reverse().find((t) => t.model)?.model,
    steps: before.filter((b) => !isSurfaced(b)),
    surfaced: before.filter(isSurfaced),
    answer: blocks.slice(cut),
  }
}

export function groupExchanges(turns: Turn[]): ThreadItem[] {
  const out: ThreadItem[] = []
  let run: AssistantTurn[] = []
  const flush = () => {
    if (run.length) out.push(toExchange(run))
    run = []
  }
  for (const t of turns) {
    if (t.type === "assistant") run.push(t)
    else {
      flush()
      out.push(t)
    }
  }
  flush()
  return out
}

/** Steps label, counted like mobile: tool calls, or blocks when there are none. */
export function stepsLabel(steps: Block[]): string {
  const n = steps.filter((b) => b.type === "tool_use").length || steps.length
  return `${n} ${n === 1 ? "step" : "steps"}`
}
