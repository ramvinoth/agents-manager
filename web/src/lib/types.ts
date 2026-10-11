import type { ModelRow } from "./providerModels"
// Domain types shared across the app — ported from the vanilla SessionParser.

export interface SessionListItem {
  /** Harness session id (the transcript stem; Copilot's dir name). */
  id?: string
  path: string
  title: string
  project: string
  modified: number
  /** When the last visible message was written (epoch s). The file's mtime
   *  (`modified`) also moves when Claude Code appends bookkeeping on resume or
   *  exit, so lists sort and show this instead; older servers omit it. */
  last_message?: number
  size: number
  /** Server-authoritative unread bit for THIS reader (principal), not per-device:
   *  true when a message arrived since this reader last opened it. */
  unread?: boolean
  /** Live run flag from _overlay_meta. NOTE: per-viewer-process truth — reflects
   *  jobs THIS viewer started, not a cross-host guarantee. */
  running?: boolean
  /** Custom-provider preset id ("" = the harness default). Resolve to a name via
   *  the store's `providers` library. */
  provider?: string
  /** Harness tag: claude | codex | copilot | pi. */
  harness?: string
  [k: string]: unknown
}

/** Harman orchestrator config — the server's master automation switch.
 *  DUPLICATED in mobile-app/src/api/client.ts, deliberately: the two apps
 *  share no build. Keep in sync BY HAND. */
export interface HarmanConfig {
  /** The master switch. Omitted by servers predating it — treat absence as OFF
   *  (a server with no gate must not be shown as running unattended work). */
  automation_enabled?: boolean
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
/** A marketplace entry (GET /api/market/mcp | /api/market/skills). MCP entries
 *  carry `install` (npm | pypi | remote, or null when only Docker/bundle exists)
 *  and the `inputs` the owner fills; skills carry `license`. */
export interface MarketInput { name: string; description: string; secret: boolean; required: boolean; default: string }
export interface MarketItem {
  id: string; title: string; description: string; repo: string
  version?: string; publisher?: string; install?: "npm" | "pypi" | "remote" | null; inputs?: MarketInput[]
  license?: string; files?: number
}
export interface MarketPage { items: MarketItem[]; cursor?: string }

export interface McpServer {
  name: string
  scope: string
  transport?: string
  target?: string
  config?: unknown
  editable: boolean
}
/** A plugin a chat runs with. `agent` plugins ship with Harman and the owner adds or
 *  removes them per chat (`included` = the chat's agent brings it by default);
 *  `machine` plugins are enabled for every Claude run on this Mac (read-only here). */
export interface Plugin {
  name: string
  description?: string
  source: "agent" | "machine"
  included: boolean
  active: boolean
}
export interface Capabilities {
  skills: Skill[]
  mcp: McpServer[]
  plugins?: Plugin[]
  /** The agent this chat was started from — where "Keep on agent" saves its setup. */
  agent?: { id: number; name: string }
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
    permission_mode?: string
    level?: string
    archived?: boolean
    favorite?: boolean
  }
  /** The Harman level this chat acts at now (override → the agent it was started from → Own work). */
  effective_level?: string
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
  /** Trust: the saved permission policy, the level override ("" = none) and
   *  the level that applies. Cheap — no transcript read. */
  permission_mode?: string
  level?: string
  effective_level?: string
}

/**
 * A saved model connection (OpenAI/Anthropic-compatible endpoint) from the
 * global library at /api/providers. One connection serves many models; `model`
 * is the default one. `models` carries each known model's context window
 * (discovered from the endpoint or overridden by the owner). `apiKey` is
 * write-only and never returned.
 */
export interface Provider {
  id: string
  name: string
  baseUrl: string
  model: string
  models?: ModelRow[]
  isDefault?: boolean
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
export interface OrgProject {
  id: number
  name: string
  description: string
  host: string
  cwd: string
  created_by: string
  created_at: number
  /** Views an agent turned on for this project (viewer/db.LENSES), e.g. "map". */
  lenses?: string[]
}
/** One box on the code Map (viewer/codemap.graph). Folder ids end in "/";
 *  symbol ids are "<file>#<Class.>name". */
export interface MapNode {
  id: string
  kind: "folder" | "file" | "class" | "function" | "method"
  label: string
  files: number
  symbols: number
  touched: boolean
  line?: number
}
export type MapLevel = "project" | "folder" | "file"
/** GET /api/org/map — one level of a project's code as a graph. */
export type MapView =
  | { available: false; level: MapLevel; path: string; install: string }
  | {
      available: true
      project: number
      level: MapLevel
      path: string
      files: number
      mermaid: string
      nodes: MapNode[]
      edges: { from: string; to: string; weight: number; kind?: string }[]
      /** file → the session id that wrote it in the last 15 minutes */
      touched: Record<string, string>
      truncated: boolean
    }
/** An intake channel (viewer/intake.py): a door from outside onto one board.
 *  POST to `path` with the channel token → a card there, waking `session_id`. */
export interface IntakeChannel {
  id: string
  name: string
  project_id: number
  session_id: string
  app_feedback: boolean
  created_by: string
  created_at: number
  last_used: number
  received: number
  path: string
  /** Only on create / new token, never on a list: shown once. */
  token?: string
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
  /** "red" is an org approval: an agent's Red action (delete, bypass mode,
   *  restart…) queued for the owner; decided with orgResolveApproval. */
  kind: "question" | "plan" | "approval" | "card" | "red"
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
  /** The approval's id (kind "approval": the tool approval; kind "red": the org approval). */
  id?: string
  /** kind "red": the queued action, who asked, and what approving it does. */
  action?: string
  requested_by?: string
  risk?: string
  /** kind "red": the asker's own one line on why it needs this ("" on old rows). */
  reason?: string
  /** The item's inbox row (0 when none was delivered) — the handle a snooze
   *  takes. The queue already omits items whose snooze is live. */
  inbox_id: number
  snoozed_until: number
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
 *  can carry a decision (kind question | plan | approval | card | red) whose
 *  open/resolved state the server derives at read time from the live sources
 *  (`open`, below) — the deciding tap stays on the per-session routes. */
export type InboxKind = "message" | "question" | "plan" | "approval" | "card" | "red"
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
export type CardFilter = { session?: string; project?: number }
/** A note in the org's knowledge ledger (viewer/db `notes`) — one table shared
 *  by the owner and every agent session's note_* MCP tools. */
export type NoteKind = "note" | "journal" | "meeting" | "idea" | "checklist" | "discussion"
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
  /** Discussion thread size and last activity (viewer/routes/orchestrator _g_org_notes). */
  replies?: number
  last_reply_at?: number | null
}
/** One comment in a note's discussion thread, nested by the server
 *  (viewer/discussion.thread): `score` is the vote sum, `my_vote` the reader's. */
export interface NoteComment {
  id: number
  note_id: number
  parent_id: number | null
  author: string
  session_id: string
  body: string
  created_at: number
  score: number
  my_vote: -1 | 0 | 1
  replies: NoteComment[]
}
export type NoteCommentSort = "best" | "new" | "old"
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

/** GET /api/integrations — the whole Integrations page in one response,
 *  built server-side from viewer/integrations.py. No secrets or tokens. */
export type ServiceState = "on" | "off" | "grant" | "unavailable"
/** One thing agents may do with a service (read, write, delete, draft…). */
export interface IntegrationOp { id: string; label: string }
export interface IntegrationService {
  id: string
  label: string
  kind: string
  /** What agents will do with it — read before granting. */
  agent: string
  /** A sample first task for "Try it in a chat" ("" when unavailable). */
  try: string
  available: boolean
  /** Why it can't be connected, when !available. */
  unavailable: string
  ops: IntegrationOp[]
}
export interface IntegrationConnection {
  id: string
  /** The signed-in account's address ("" for a connection made before it was recorded). */
  account: string
  authorized: boolean
  /** The vendor refused the refresh token; only Reconnect (a new consent) revives it. */
  expired: boolean
  services: Record<string, ServiceState>
  /** Per service, per op: the owner's switch for AGENTS (humans are bounded by the grant only). */
  ops: Record<string, Record<string, ServiceState>>
  /** The folder a files account is narrowed to; "/" is the whole account. */
  root: string
}
/** One step of a provider's client setup; `redirect` shows the copyable redirect URI under it. */
export interface SetupStep { text: string; redirect: boolean; links: { label: string; url: string }[] }
/** One extra box a token provider's connect form asks for (Odoo's address, Mixpanel's username). */
export interface IntegrationField { id: string; label: string; placeholder: string; required: boolean }
export interface IntegrationProvider {
  id: string
  label: string
  /** How an account is connected: a vendor sign-in (OAuth) or a pasted API token.
   *  Absent on servers predating token providers — read as "oauth". */
  auth?: "oauth" | "token"
  /** A CATEGORIES id ("workspace", "compute"…); absent on older servers. */
  category?: string
  fields?: IntegrationField[]
  /** A PKCE public client — no secret is issued or needed. */
  public: boolean
  /** The vendor-console checklist for creating the OAuth client, in order. */
  setup: SetupStep[]
  client: { client_id: string; has_secret: boolean; configured: boolean }
  services: IntegrationService[]
  connections: IntegrationConnection[]
}
/** The folders agents may touch on the server's own disk, and what they may do there. */
export interface LocalDisk { roots: string[]; ops: (IntegrationOp & { on: boolean })[] }
export interface IntegrationCategory { id: string; label: string }
export interface IntegrationsView {
  providers: IntegrationProvider[]
  /** The order and names of the "Add an account" groups; absent on older servers. */
  categories?: IntegrationCategory[]
  redirect_uri: string
  local: LocalDisk
}
