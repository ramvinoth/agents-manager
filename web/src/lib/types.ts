// Domain types shared across the app — ported from the vanilla SessionParser.

export interface SessionListItem {
  path: string
  title: string
  project: string
  modified: number
  size: number
  [k: string]: unknown
}

/** Harman orchestrator config — the server's master automation switch.
 *  DUPLICATED in mobile-app/src/api/client.ts, deliberately: the two apps
 *  share no build. Keep in sync BY HAND. */
export interface HarmanConfig {
  /** The master switch. Omitted by servers predating it — treat absence as on. */
  automation_enabled?: boolean
  enabled: boolean
  interval: number
  budget: number
  projects: number[]
  default_provider: string
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
  /** Custom LLM provider preset id ("" or undefined = Default/Claude). */
  provider?: string
  /** Conversation mode for a custom provider: plain proxy vs full agent harness. */
  convMode?: "chat" | "agent"
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
  nextRun?: number
  runs?: number
  enabled?: boolean
}
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
}
export type CardFilter = { session?: string; project?: number; assignee?: number }
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
