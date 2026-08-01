// Lightweight transcript parser for the mobile chat thread.
//
// Ported from web/src/lib/parser.ts (SessionParser) but slimmed to what the
// thread renders: an ordered list of turns (user / assistant / system) with
// text, tool calls, and inline images. Stats/token-timeline/fork bookkeeping
// from the web parser are intentionally dropped — the phone only draws bubbles.

export type ImagePart = { mime: string; data: string }

/** A short wall-clock label for a message/tool timestamp, e.g. "3:45 PM".
 *  Returns "" for a missing/unparseable ts so callers can skip rendering. */
export function fmtClock(ts?: string): string {
  if (!ts) return ""
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ""
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
}
/** A WhatsApp-style day label for the floating scroll header: "Today",
 *  "Yesterday", or a full date like "28 July 2026". Returns "" for a
 *  missing/unparseable ts so callers can skip rendering. */
export function fmtDate(ts?: string): string {
  if (!ts) return ""
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ""
  const now = new Date()
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayMs = 86400000
  const diff = Math.round((startOf(now) - startOf(d)) / dayMs)
  if (diff === 0) return "Today"
  if (diff === 1) return "Yesterday"
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  })
}
export type TextBlock = { kind: "text"; text: string }
export type ToolBlock = { kind: "tool"; name: string; input: unknown; id: string; result: unknown; isError?: boolean; answered?: boolean; ts?: string }
export type Block = TextBlock | ToolBlock
// `uuid` is the transcript record id. Fork and revert both cut the session at a
// specific message, so it has to survive parsing — see /api/session/fork.
export type Turn =
  | { role: "user"; id: string; text: string; images?: ImagePart[]; ts?: string; uuid?: string }
  | { role: "assistant"; id: string; blocks: Block[]; ts?: string; uuid?: string }
  | { role: "system"; id: string; text: string; ts?: string; uuid?: string }

// Grouped view: one item per user message / system line, and one "exchange" per
// run of consecutive assistant turns. The exchange carries the agent's FINAL
// text response plus its intermediate "steps" (tool calls + narration) so the UI
// can show the answer and collapse the work underneath it.
// `question` carries an UNANSWERED AskUserQuestion tool call. It must surface
// prominently — buried in the collapsed steps the user never sees the agent is
// waiting on them, and the conversation just stalls.
// `plan` carries an ExitPlanMode tool call whose input.plan is the full proposed
// plan (markdown). Surfaced as its own card so it renders as formatted text, not
// a raw-JSON tool chip.
export type ExchangeItem = { kind: "exchange"; id: string; uuid?: string; finalText: string; steps: Block[]; question?: ToolBlock; plan?: ToolBlock; ts?: string }
export type ThreadItem =
  | { kind: "user"; id: string; text: string; images?: ImagePart[]; uuid?: string; ts?: string }
  | { kind: "system"; id: string; text: string; ts?: string }
  | ExchangeItem

/** Collapse Turn[] into render items, grouping each agent exchange. */
export function groupThread(turns: Turn[]): ThreadItem[] {
  const items: ThreadItem[] = []
  let acc: Block[] | null = null
  let accId = ""
  let accUuid: string | undefined
  let accTs: string | undefined

  const flush = () => {
    if (!acc) return
    // The trailing run of text blocks is the "final response"; everything before
    // it (tool calls + any intermediate narration) becomes collapsible steps.
    let cut = acc.length
    while (cut > 0 && acc[cut - 1].kind === "text") cut--
    let steps = acc.slice(0, cut)
    const finalText = acc
      .slice(cut)
      .map((b) => (b.kind === "text" ? b.text : ""))
      .join("\n\n")
      .trim()
    // Pull an UNANSWERED AskUserQuestion out of the steps so it renders as a
    // tappable question card instead of hiding behind "N steps".
    const qi = steps.findIndex((b) => b.kind === "tool" && b.name === "AskUserQuestion" && b.result == null)
    let question: ToolBlock | undefined
    if (qi !== -1) {
      question = steps[qi] as ToolBlock
      steps = steps.filter((_, i) => i !== qi)
    }
    // Pull an ExitPlanMode call out of the steps so its markdown plan renders as a
    // formatted plan card instead of a raw-JSON tool chip. Take the last one (the
    // final proposed plan) if the agent re-planned.
    const pis = steps.map((b, i) => (b.kind === "tool" && b.name === "ExitPlanMode" ? i : -1)).filter((i) => i >= 0)
    let plan: ToolBlock | undefined
    if (pis.length) {
      const pi = pis[pis.length - 1]
      plan = steps[pi] as ToolBlock
      steps = steps.filter((_, i) => i !== pi)
    }
    items.push({ kind: "exchange", id: accId, uuid: accUuid, finalText, steps, question, plan, ts: accTs })
    acc = null
    accTs = undefined
  }

  for (const t of turns) {
    if (t.role === "assistant") {
      if (!acc) {
        acc = []
        accId = t.id
        accUuid = t.uuid
        accTs = t.ts // the exchange's time is when the agent's turn began
      }
      acc.push(...t.blocks)
    } else {
      flush()
      if (t.role === "user") items.push({ kind: "user", id: t.id, text: t.text, images: t.images, uuid: t.uuid, ts: t.ts })
      else items.push({ kind: "system", id: t.id, text: t.text, ts: t.ts })
    }
  }
  flush()
  return items
}

/** Stable pin identity for a render item: the transcript uuid (user + exchange). */
export function itemUuid(it: ThreadItem): string | undefined {
  if (it.kind === "user") return it.uuid
  if (it.kind === "exchange") return it.uuid
  return undefined
}

/** Short preview text for a pinned message (banner / profile list). */
export function itemPreview(it: ThreadItem): string {
  if (it.kind === "user") return it.text
  if (it.kind === "exchange") return it.finalText || (it.plan ? "Proposed plan" : it.question ? "Question" : "…")
  if (it.kind === "system") return it.text
  return ""
}

const SKIP_TYPES = new Set([
  "mode",
  "file-history-snapshot",
  "last-prompt",
  "custom-title",
  "agent-name",
  "permission-mode",
  "queue-operation",
  "attachment",
  "summary",
])

/** Flatten a tool result (string | content-array | object) to display text. */
export function resultToText(v: unknown): string {
  if (v == null) return ""
  if (typeof v === "string") return v
  if (Array.isArray(v))
    return (v as any[])
      .map((b) => {
        if (typeof b === "string") return b
        if (b?.type === "image") return "" // shown separately as an <Image>
        return b?.text ?? JSON.stringify(b)
      })
      .filter(Boolean)
      .join("\n")
  return JSON.stringify(v, null, 2)
}

/** The prefix the server puts on a composed AskUserQuestion answer (viewer
 *  questions.answer_message). Kept in sync so the app can recognise an answered
 *  question and render it as success, not the CLI's "deny" (red error). */
const ANSWER_PREFIX = "My answer to your question"

export function isAnswerEnvelope(result: unknown): boolean {
  return resultToText(result).trimStart().startsWith(ANSWER_PREFIX)
}

/** Pull base64 image blocks out of Anthropic-style message/tool-result content. */
export function extractImages(content: unknown): ImagePart[] {
  if (!Array.isArray(content)) return []
  const out: ImagePart[] = []
  for (const b of content as any[]) {
    if (b && b.type === "image" && b.source?.type === "base64" && b.source.data)
      out.push({ mime: b.source.media_type || "image/png", data: b.source.data })
  }
  return out
}

/**
 * Parse transcript records into ordered turns. Accepts the `lines` array from
 * the server's /api/session envelope ({start,end,size,lines:[...]}) — each entry
 * is one JSONL record string — or a raw newline-delimited string as a fallback.
 */
export function parseTranscript(input: string[] | string): Turn[] {
  const lines = Array.isArray(input) ? input : input.split("\n")
  const objs: any[] = []
  for (const l of lines) {
    if (!l || !l.trim()) continue
    try {
      objs.push(JSON.parse(l))
    } catch {
      /* skip malformed line */
    }
  }

  // Pass 1: collect tool results so tool_use blocks can show their output/errors.
  const toolResults: Record<string, unknown> = {}
  const toolErrors: Record<string, boolean> = {}
  for (const o of objs) {
    if (o.type === "user" && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) {
        if (b.type === "tool_result") {
          toolResults[b.tool_use_id] = b.content
          if (b.is_error) toolErrors[b.tool_use_id] = true
        }
      }
    }
  }

  // Pass 2: build turns.
  const seen = new Set<string>()
  const turns: Turn[] = []
  let n = 0
  const id = () => "m" + ++n

  for (const msg of objs) {
    if (SKIP_TYPES.has(msg.type)) continue
    if (msg.uuid) {
      if (seen.has(msg.uuid)) continue
      seen.add(msg.uuid)
    }
    if (msg.isMeta) continue

    if (msg.type === "user" && msg.message) {
      const content = msg.message.content
      if (Array.isArray(content) && content.length && content.every((b: any) => b.type === "tool_result")) continue
      if (typeof content === "string" && content.startsWith("<local-command")) continue

      // Background-task events → compact system line (not a raw-XML "you" bubble).
      if (typeof content === "string" && content.startsWith("<task-notification>")) {
        const tid = content.match(/<task-id>(.*?)<\/task-id>/)?.[1]
        const status = content.match(/<status>(.*?)<\/status>/)?.[1]
        turns.push({
          role: "system",
          id: id(),
          text: `Background task${tid ? ` ${tid}` : ""}${status ? ` — ${status}` : ""}`,
          ts: msg.timestamp,
        })
        continue
      }
      // Slash-command invocations arrive wrapped in <command-name>/<command-args>.
      if (typeof content === "string" && /<command-name>/.test(content)) {
        const cm = content.match(/<command-name>\/?([\w:-]+)<\/command-name>/)
        const am = content.match(/<command-args>([\s\S]*?)<\/command-args>/)
        turns.push({ role: "user", id: id(), text: `/${cm?.[1] || "cmd"} ${(am?.[1] || "").trim()}`.trim(), ts: msg.timestamp, uuid: msg.uuid })
        continue
      }

      const images = extractImages(content)
      let text: string
      if (typeof content === "string") text = content
      else if (Array.isArray(content))
        text =
          content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n") || (images.length ? "" : "")
      else text = ""
      turns.push({ role: "user", id: id(), text, images: images.length ? images : undefined, ts: msg.timestamp, uuid: msg.uuid })
      continue
    }

    if (msg.type === "assistant" && msg.message) {
      const blocks: Block[] = []
      for (const b of msg.message.content || []) {
        if (b.type === "text" && b.text) blocks.push({ kind: "text", text: b.text })
        else if (b.type === "tool_use") {
          // AskUserQuestion answers arrive via the permission channel as a "deny"
          // whose message is the user's pick — the CLI flags that tool_result as
          // an error, but it is really a SUCCESSFUL answer. Detect our own answer
          // envelope and present it as answered (not a red failure).
          const rawResult = toolResults[b.id] ?? null
          const answered = b.name === "AskUserQuestion" && isAnswerEnvelope(rawResult)
          blocks.push({
            kind: "tool",
            name: b.name,
            input: b.input,
            id: b.id,
            result: rawResult,
            isError: answered ? false : toolErrors[b.id],
            answered,
            ts: msg.timestamp,
          })
        }
      }
      if (!blocks.length) continue
      turns.push({ role: "assistant", id: id(), blocks, ts: msg.timestamp, uuid: msg.uuid })
      continue
    }

    if (msg.type === "system" && msg.content) {
      const c = String(msg.content)
        .replace(/<[^>]+>/g, "")
        .trim()
      if (c.length > 2) turns.push({ role: "system", id: id(), text: c, ts: msg.timestamp })
    }
  }

  return turns
}
