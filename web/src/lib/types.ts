// Domain types shared across the app — ported from the vanilla SessionParser.

/** The employee driving a session — the org↔fleet join attached by
 *  _overlay_meta when a session's token carries an employee_id. Absent on
 *  sessions with no linked persona. */
export interface SessionPersona {
  id: number
  name: string
  role: string
  avatar: string
}

export interface SessionListItem {
  path: string
  title: string
  project: string
  modified: number
  size: number
  /** Server-authoritative unread bit for THIS reader (principal), not per-device:
   *  true when the transcript changed since this reader last opened it. */
  unread?: boolean
  /** Live run flag from _overlay_meta. NOTE: per-viewer-process truth — reflects
   *  jobs THIS viewer started, not a cross-host guarantee. */
  running?: boolean
  /** Custom-provider preset id ("" = the harness default). Resolve to a name via
   *  the store's `providers` library. */
  provider?: string
  /** Harness tag: claude | codex | copilot | pi. */
  harness?: string
  /** The employee driving this session (org↔fleet join); absent when unlinked. */
  persona?: SessionPersona
  [k: string]: unknown
}

/** Harman orchestrator config — the server's master automation switch.
 *  DUPLICATED in mobile-app/src/api/client.ts, deliberately: the two apps
 *  share no build. Keep in sync BY HAND. */
export interface HarmanConfig {
  /** The master switch. Omitted by servers predating it — treat absence as OFF
   *  (a server with no gate must not be shown as running unattended work). */
  automation_enabled?: boolean
  enabled: boolean
  interval: number
  budget: number
  projects: number[]
  default_provider: string
}

/** WHICH loop origins may fire — orthogonal to the automation master switch.
 *  user→your loops only (default), harman→agent loops only, both, none→paused.
 *  DUPLICATED in mobile-app/src/api/client.ts — keep in sync BY HAND. */
export type LoopMode = "user" | "harman" | "both" | "none"
export interface LoopControl {
  mode: LoopMode
}

export interface HostInfo {
  id: string
  label: string
  host: string
  user: string
  port: number
  auth?: "password" | "key"
  keyFile?: string
}

export interface TextBlock {
  type: "text"
  text: string
}
export interface ToolUseBlock {
  type: "tool_use"
  name: string
  input: unknown
  id: string
  result: unknown | null
  isError?: boolean
}
export type Block = TextBlock | ToolUseBlock

export interface ImagePart {
  mime: string
  data: string
}
export interface UserTurn {
  type: "user"
  domId: string
  content: string
  images?: ImagePart[]
  timestamp?: string
  uuid?: string
}
export interface AssistantTurn {
  type: "assistant"
  domId: string
  blocks: Block[]
  model?: string
  usage?: { input_tokens?: number; output_tokens?: number } | null
  timestamp?: string
  uuid?: string
  stopReason?: string
}
export interface SystemTurn {
  type: "system"
  domId: string
  content: string
  timestamp?: string
  uuid?: string
}
export type Turn = UserTurn | AssistantTurn | SystemTurn

export interface TokenPoint {
  timestamp?: string
  input: number
  output: number
}

export interface ParserStats {
  totalInput: number
  totalOutput: number
  tools: Record<string, number>
  userMessages: number
  assistantMessages: number
  totalMessages: number
  tokenTimeline: TokenPoint[]
}

export interface ParserMetadata {
  title: string
  agentName: string
  models: Set<string>
  sessionId: string
  startTime: Date | null
  endTime: Date | null
  duration: number
  summaries: string[]
}

export interface IngestResult {
  turn: Turn | null
  updated: string[]
}

export interface Skill {
  name: string
  description?: string
  source: string
  path: string
  editable: boolean
}
export interface McpServer {
  name: string
  scope: string
  transport?: string
  target?: string
  config?: unknown
  editable: boolean
}
export interface Capabilities {
  skills: Skill[]
  mcp: McpServer[]
  models?: { v: string; label: string }[] // Copilot: dynamic per-plan model picker list
}

/** The composed per-session document from /api/session-detail: meta + caps +
 *  summary + live run flag, in one call. Sections degrade to {error} on failure,
 *  so every field is optional. Used by the chat list's inline expander to reveal
 *  a peer session's skills·MCP·cwd·model without opening it. */
export interface SessionDetail {
  session: string
  host: string
  agent: string
  running: boolean
  meta: {
    goal?: string
    systemPrompt?: string
    avatar?: string
    provider?: string
    convMode?: string
    effort?: string
    archived?: boolean
    favorite?: boolean
  }
  capabilities: Capabilities
  summary: SessionSummary & { error?: string }
}

export interface AgentInfo {
  id: string
  label: string
  vendor?: string
  bin?: string
  home?: string
  install?: string
  login?: string
  docs?: string
  installed: boolean
  loggedIn?: boolean
}

export interface SessionAnalysis {
  assumptions: string[]
  decisions: string[]
  at?: number // user-message count when the analysis was run (client-stamped)
}

export interface SlashCommand {
  name: string
  description?: string
  source?: string
  interactive?: boolean
  handler?: string
}

export interface SessionSummary {
  lines: number
  userMessages: number
  assistantMessages: number
  totalInput: number
  totalOutput: number
  tools: Record<string, number>
  models: string[]
  title?: string
  summaries?: string[]
  startTime?: string
  endTime?: string
  cwd?: string
  tokenTimeline?: { input: number; output: number }[]
}

export interface SessionMeta {
  session?: string
  goal?: string
  systemPrompt?: string
  cwd?: string
}

/**
 * A saved custom LLM provider (OpenAI/Anthropic-compatible endpoint) from the
 * global library at /api/providers. `apiKey` is never returned by the server —
 * it's write-only. `contextLimit` is the endpoint's real max context in tokens
 * (0/undefined = unknown), used to declare the window to the agent harness.
 */
export interface Provider {
  id: string
  name: string
  baseUrl: string
  model: string
  contextLimit?: number
}

export interface GitRepo {
  fullName: string
  name: string
  private: boolean
  defaultBranch: string
  pushedAt?: string
}
export interface GitStatus {
  repo: boolean
  branch?: string
  name?: string
  remote?: string
  root?: string
  dirty?: number
  ahead?: number | null
  behind?: number | null
}
export interface Loop {
  id: string
  session: string
  prompt: string
  interval: number
  /** "once" fires at nextRun then retires; "recurring" (default) repeats every `interval`. */
  kind?: "recurring" | "once"
  nextRun?: number
  runs?: number
  enabled?: boolean
  /** Custom provider preset id these runs use ("" = inherit the session's own). */
  provider?: string
}
/** Schedule a loop is created/edited with. Server precedence: `at` (one-shot,
 *  ISO datetime with offset) beats `interval`; whichever is present rebuilds the
 *  whole schedule, so a one-shot edited with an interval becomes recurring. */
export type LoopSchedule = { interval?: number; at?: string }
export type VisibleTypes = { user: boolean; assistant: boolean; system: boolean; tools: boolean }

// ---- org / Kanban ----------------------------------------------------------
export interface Employee {
  id: number
  name: string
  role: string
  provider: string
  model: string
  conv_mode: string
  avatar: string
  status: string
  created_at: number
}
export interface OrgProject {
  id: number
  name: string
  description: string
  host: string
  cwd: string
  created_by: string
  created_at: number
}
export interface BoardColumn {
  id: number
  project_id: number
  name: string
  position: number
}
/** A card→card dependency edge: the card is blocked until this card reaches a Done column. */
export interface CardDep {
  id: number
  title: string
  column_name: string
  done: boolean
}
export interface Card {
  id: number
  title: string
  body: string
  column_id: number | null
  assignee: number | null
  project_id: number | null
  session_id: string | null
  position: number
  created_by: string
  created_at: number
  updated_at: number
  /** How many messages are in the card's thread (the badge on the board). */
  comment_count?: number
  /** Dependency edges (dual control: the owner and the card's session see the same rows). */
  dependencies?: CardDep[]
}
/** One row of the cross-session decision queue (GET /api/decisions/open): a
 *  durable question, a durable plan, or a live tool approval. The queue is a
 *  READ of the existing sources — deciding an item uses the per-session
 *  routes, never this shape. */
export interface OpenDecision {
  kind: "question" | "plan" | "approval" | "card"
  session: string
  host: string
  /** The session's human-readable name (its title/goal/project), "" if unknown. */
  label: string
  /** Seconds the decision has been waiting. */
  waiting_s: number
  /** Bounded one-liner: the question text / plan excerpt / secret-safe tool preview. */
  summary: string
  question_count?: number
  tool_use_id?: string
  run_id?: string
  revision?: number
  tool_name?: string
  /** The approval's id (only for kind "approval"). */
  id?: string
  /** kind "card": the board card parked in Review/Needs-info for the owner, and its column. */
  card?: number
  column?: string
}
export interface CardComment {
  id: number
  card_id: number
  author: string
  body: string
  created_at: number
}
/** One row of the message ledger (viewer/db `inbox_messages`). The inbox is a
 *  DELIVERY SURFACE over the existing decision system, not a second one: a row
 *  can carry a decision (kind question | plan | approval | card) whose
 *  open/resolved state the server derives at read time from the live sources
 *  (`open`, below) — the deciding tap stays on the per-session routes. */
export type InboxKind = "message" | "question" | "plan" | "approval" | "card"
export type InboxStatus = "sent" | "read" | "snoozed"
export interface InboxMessage {
  id: number
  session_id: string
  project_id: number | null
  sender_type: string   // "user" | "session"
  sender_id: string
  recipient_type: string
  recipient_id: string
  body: string
  kind: InboxKind
  ref_id: string
  in_reply_to: number
  status: InboxStatus
  snoozed_until: number | null
  archived: boolean
  created_at: number
  updated_at: number
  /** Added by GET /api/inbox (attach_state): decision kinds say whether the
   *  underlying decision is still open; messages are null. */
  open?: boolean | null
  /** Added by GET /api/inbox: the effective status once a lapsed snooze is
   *  re-read as 'sent' (a skipped decision resurfaces, never drops). */
  effective_status?: InboxStatus
  /** Added by GET /api/inbox: true while the snooze is still in effect. */
  snoozed?: boolean
}
export type InboxFilter = { session?: string; project?: number; kind?: InboxKind; unread_only?: boolean; archived?: boolean }
export type CardFilter = { session?: string; project?: number; assignee?: number }
/** A note in the org's knowledge ledger (viewer/db `notes`) — one table shared
 *  by the owner and every agent session's note_* MCP tools. */
export type NoteKind = "note" | "journal" | "meeting" | "idea" | "checklist"
export interface Note {
  id: number
  title: string
  body: string
  kind: NoteKind
  project_id: number | null
  session_id: string | null
  pinned: boolean
  archived: boolean
  created_by: string
  created_at: number
  updated_at: number
}
export type NoteFilter = { session?: string; project?: number; archived?: boolean }
/** A Red action the caller wasn't allowed to self-approve comes back as an OPEN
 *  APPROVAL, not the resource — `{queued, approval}` at status **200** (see
 *  viewer/actions.py execute). Writes whose action is Red are typed `T | Queued`
 *  so the compiler forces the call site to decide, instead of letting a queued
 *  request read as a completed one. Mirrors mobile-app/src/api/client.ts. */
export type Queued = { queued: true; approval: number }
export const isQueued = (r: unknown): r is Queued =>
  !!r && (r as Queued).queued === true


export interface FileEntry {
  name: string
  dir: boolean
  size: number
  mtime: number
}
export interface FileListResponse {
  path: string
  parent?: string
  entries: FileEntry[]
  home: string
  truncated?: boolean
}

/** A cloud drive in the file browser's location picker — the sanitized view
 *  the server returns (no tokens, no client secret). `authorized` is the
 *  "has a usable token" presence flag; an unauthorized drive still lists but
 *  selecting it re-runs the consent flow. */
export interface Drive {
  id: string
  label: string
  kind: string
  status: string
  hidden: boolean
  authorized: boolean
}
