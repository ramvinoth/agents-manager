// SessionParser — incremental JSONL → renderable turns. Ported verbatim (logic)
// from the vanilla app's SessionParser class.
import type {
  Block,
  ImagePart,
  IngestResult,
  ParserMetadata,
  ParserStats,
  ToolUseBlock,
  Turn,
} from "./types"

/** Pull base64 image blocks out of Anthropic-style message/tool-result content
 *  ({ type:"image", source:{ type:"base64", media_type, data } }). */
export function extractImages(content: unknown): ImagePart[] {
  if (!Array.isArray(content)) return []
  const out: ImagePart[] = []
  for (const b of content as any[]) {
    if (b && b.type === "image" && b.source?.type === "base64" && b.source.data)
      out.push({ mime: b.source.media_type || "image/png", data: b.source.data })
  }
  return out
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

export class SessionParser {
  metadata!: ParserMetadata
  stats!: ParserStats
  private toolResults!: Record<string, unknown>
  private toolErrors!: Record<string, boolean>
  private toolUseIndex!: Record<string, { block: ToolUseBlock }>
  private seen!: Set<string>
  private counter!: number

  constructor() {
    this.reset()
  }

  reset() {
    this.metadata = {
      title: "",
      agentName: "",
      models: new Set(),
      sessionId: "",
      startTime: null,
      endTime: null,
      duration: 0,
      summaries: [],
    }
    this.stats = {
      totalInput: 0,
      totalOutput: 0,
      tools: {},
      userMessages: 0,
      assistantMessages: 0,
      totalMessages: 0,
      tokenTimeline: [],
    }
    this.toolResults = {}
    this.toolErrors = {}
    this.toolUseIndex = {}
    this.seen = new Set()
    this.counter = 0
  }

  ingest(line: string, prepend = false): IngestResult | null {
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      return null
    }
    const md = this.metadata
    const st = this.stats
    if (obj.type === "custom-title" && obj.customTitle) md.title = obj.customTitle
    if (obj.type === "summary" && obj.summary && !md.summaries.includes(obj.summary))
      md.summaries.push(obj.summary)
    if (obj.type === "agent-name" && obj.agentName) md.agentName = obj.agentName
    if (obj.sessionId && !md.sessionId) md.sessionId = obj.sessionId
    if (obj.timestamp) {
      const ts = new Date(obj.timestamp)
      if (!md.startTime || ts < md.startTime) md.startTime = ts
      if (!md.endTime || ts > md.endTime) md.endTime = ts
      md.duration = (md.endTime as Date).getTime() - (md.startTime as Date).getTime()
    }
    if (obj.type === "assistant" && obj.message?.model && obj.message.model !== "<synthetic>")
      md.models.add(obj.message.model)

    st.totalMessages++
    if (obj.type === "user" && !obj.isMeta) {
      const c = obj.message?.content
      const toolOnly =
        Array.isArray(c) && c.length && c.every((b: any) => b && b.type === "tool_result")
      if (!toolOnly) st.userMessages++
    }
    if (obj.type === "assistant") {
      st.assistantMessages++
      const u = obj.message?.usage
      if (u) {
        const pt = {
          timestamp: obj.timestamp,
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
        }
        st.totalInput += pt.input
        st.totalOutput += pt.output
        if (prepend) st.tokenTimeline.unshift(pt)
        else st.tokenTimeline.push(pt)
      }
      for (const b of obj.message?.content || [])
        if (b.type === "tool_use") st.tools[b.name] = (st.tools[b.name] || 0) + 1
    }

    const updated: string[] = []
    if (obj.type === "user" && Array.isArray(obj.message?.content)) {
      for (const b of obj.message.content) {
        if (b.type === "tool_result") {
          this.toolResults[b.tool_use_id] = b.content
          if (b.is_error) this.toolErrors[b.tool_use_id] = true
          const ref = this.toolUseIndex[b.tool_use_id]
          if (ref && ref.block.result == null) {
            ref.block.result = b.content
            if (b.is_error) ref.block.isError = true
            updated.push(b.tool_use_id)
          }
        }
      }
    }

    return { turn: this.buildTurn(obj), updated }
  }

  private buildTurn(msg: any): Turn | null {
    if (SKIP_TYPES.has(msg.type)) return null
    if (msg.uuid) {
      if (this.seen.has(msg.uuid)) return null
      this.seen.add(msg.uuid)
    }
    if (msg.isMeta) return null
    const domId = "t" + ++this.counter
    if (msg.type === "user" && msg.message) {
      const content = msg.message.content
      if (Array.isArray(content) && content.every((b: any) => b.type === "tool_result"))
        return null
      if (typeof content === "string" && content.startsWith("<local-command")) return null
      // Background-task events are injected as user-role messages whose content is
      // a bare <task-notification> block (no isMeta flag, userType "external"), so
      // without this they'd render as a raw-XML "You" bubble. Show a compact
      // system line instead, reusing the SystemTurn rendering.
      if (typeof content === "string" && content.startsWith("<task-notification>")) {
        const id = content.match(/<task-id>(.*?)<\/task-id>/)?.[1]
        const status = content.match(/<status>(.*?)<\/status>/)?.[1]
        const summary = content.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim()
        const label = `⚙ background task${id ? ` ${id}` : ""}${status ? ` — ${status}` : ""}`
        return {
          type: "system",
          domId,
          content: summary ? `${label}: ${summary}` : label,
          timestamp: msg.timestamp,
          uuid: msg.uuid,
        }
      }
      // Slash-command invocations arrive wrapped in <command-message>/<command-name>/
      // <command-args>. The block may start with either <command-message> (most
      // commands) or <command-name>, so match on the presence of <command-name>
      // rather than a fixed prefix. Args can span multiple lines ([\s\S]).
      if (typeof content === "string" && /<command-name>/.test(content)) {
        const cm = content.match(/<command-name>\/?([\w:-]+)<\/command-name>/)
        const am = content.match(/<command-args>([\s\S]*?)<\/command-args>/)
        return {
          type: "user",
          domId,
          content: `/${cm?.[1] || "cmd"} ${(am?.[1] || "").trim()}`.trim(),
          timestamp: msg.timestamp,
          uuid: msg.uuid,
        }
      }
      const images = extractImages(content)
      let text: string
      if (typeof content === "string") text = content
      else if (Array.isArray(content))
        text =
          content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n") || (images.length ? "" : JSON.stringify(content))
      else text = JSON.stringify(content)
      return {
        type: "user",
        domId,
        content: text,
        images: images.length ? images : undefined,
        timestamp: msg.timestamp,
        uuid: msg.uuid,
      }
    }
    if (msg.type === "assistant" && msg.message) {
      const blocks: Block[] = []
      for (const b of msg.message.content || []) {
        if (b.type === "text" && b.text) blocks.push({ type: "text", text: b.text })
        else if (b.type === "tool_use") {
          const blk: ToolUseBlock = {
            type: "tool_use",
            name: b.name,
            input: b.input,
            id: b.id,
            result: this.toolResults[b.id] ?? null,
            isError: this.toolErrors[b.id],
          }
          blocks.push(blk)
          this.toolUseIndex[b.id] = { block: blk }
        }
      }
      if (!blocks.length) return null
      return {
        type: "assistant",
        domId,
        blocks,
        model: msg.message.model,
        usage: msg.message.usage,
        timestamp: msg.timestamp,
        uuid: msg.uuid,
        stopReason: msg.message.stop_reason,
      }
    }
    if (msg.type === "system" && msg.content) {
      const c = String(msg.content)
        .replace(/<[^>]+>/g, "")
        .trim()
      if (c.length > 2)
        return { type: "system", domId, content: c, timestamp: msg.timestamp, uuid: msg.uuid }
    }
    return null
  }
}
