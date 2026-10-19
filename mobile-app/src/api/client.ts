/**
 * Typed client for the Agents server HTTP + WebSocket API.
 *
 * Mirrors web/src/lib/api.ts, but authenticates with a Bearer token (mobile has
 * no cookie jar) instead of the HttpOnly `viewer_session` cookie. The backend
 * accepts either — see viewer/server.py `_auth_token`.
 */
import { serverFetch, serverMedia, serverSocket, serverUpload, serverDownload } from "./transport"
import { normModel } from "../lib/model"
import { isTransportError } from "../lib/errors"
import { reachability } from "../lib/reachability"
import type { AIConfig, AISelection, ConnectionDraft, KeyAction, ModelDiscovery } from "../lib/aiSelection"
import type { NewChatJob } from "../lib/newChat"
import type { ModelRow } from "../lib/providerModels"
import { auditPath, parseAuditPage, type AuditFilter } from "../lib/audit"
import type { NoteGraph } from "../lib/noteLinks"
import type { UsageEvent } from "../lib/usage"

export type User = { id: number; username: string; role?: string }
export type Host = {
  id: string
  label: string
  host: string
  user: string
  port: number
  auth: "key" | "password"
  keyFile: string
}
export type ChatResult = { session: string }
/** The call brain's conversation memory (OpenAI-style messages). Opaque to the
 *  app: stored between turns and sent back verbatim. */
export type CallHistory = Array<Record<string, unknown>>
/** The Nemotron GPU service's /health, passed through by the viewer as-is (see
 *  viewer.nemotron.status / deploy/voicechat_service.py `health`). Every field
 *  but `enabled` is the SERVER's own claim about itself — the phone must never
 *  hardcode a backend name/model or infer capabilities from anywhere else.
 *  `tools`/`duplex` are always false for this backend today; the UI must never
 *  promise delegation or true two-way audio regardless of `model`/`backend`. */
export type NemotronStatus = {
  enabled: boolean
  installed: boolean
  ready: boolean
  busy: boolean
  backend?: string
  model?: string
  input?: { format: string; rate: number; channels: number; max_seconds: number }
  output?: { format: string; rate: number; channels: number }
  tools?: boolean
  duplex?: boolean
  error?: string
}
/** GET /api/call/engine — the server's decision about which path a call runs on
 *  (viewer.callbrain.choose_engine). `model` is the server's own name for the
 *  brain; `error` means the brain is not configured and a call cannot start. */
export type CallEngine = { engine: "brain" | "nemotron"; model?: string; error?: string }
export type Project = { cwd: string; modified?: number }
export type SlashCommand = { name: string; description?: string; source?: string; interactive?: boolean }
export type FileEntry = { name: string; dir: boolean; size: number; mtime: number }
export type FileList = { path: string; parent?: string; entries: FileEntry[]; home?: string; truncated?: boolean }
/** Where a file call looks: an SSH host, a cloud drive, or (empty) this machine. */
export type FsScope = { drive: string } | { host: string } | {}
/** A connected (or connectable) cloud drive. `authorized` is a "has a usable
 *  token" flag; an unauthorized drive still lists, picking it runs consent. */
export type Drive = { id: string; label: string; kind: string; status: string; hidden: boolean; authorized: boolean }
/** GET /api/integrations — the Integrations screen in one response, built
 *  server-side from viewer/integrations.py. No secrets or tokens. */
export type ServiceState = "on" | "off" | "grant" | "unavailable"
/** One thing an agent may do with a service (read, draft, create, delete…). */
export type IntegrationOp = { id: string; label: string }
export type IntegrationService = { id: string; label: string; kind: string; agent: string; try: string; available: boolean; unavailable: string; ops: IntegrationOp[] }
export type IntegrationConnection = {
  id: string
  account: string
  authorized: boolean
  /** The vendor refused the refresh token; only Reconnect (a new consent) revives it. */
  expired: boolean
  services: Record<string, ServiceState>
  /** Per service, per op: may AGENTS do it here ("grant" = needs extra consent). */
  ops: Record<string, Record<string, ServiceState>>
  /** The folder a files connection is narrowed to ("/" = the whole account). */
  root: string
}
/** One step of a provider's client setup; `redirect` shows the copyable redirect URI under it. */
export type SetupStep = { text: string; redirect: boolean; links: { label: string; url: string }[] }
/** One extra box a token provider's connect form asks for (Odoo's address, Mixpanel's username). */
export type IntegrationField = { id: string; label: string; placeholder: string; required: boolean }
export type IntegrationProvider = {
  id: string
  label: string
  /** How an account is connected: a vendor sign-in (OAuth) or a pasted API token.
   *  Absent on servers predating token providers — read as "oauth". */
  auth?: "oauth" | "token"
  /** A categories id ("workspace", "compute"…); absent on older servers. */
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
/** What agents may do on this machine's disk (viewer/integrations.local_view). */
export type LocalDisk = { roots: string[]; ops: (IntegrationOp & { on: boolean })[] }
export type IntegrationCategory = { id: string; label: string }
/** `categories`: the order and names of the "Add an account" groups; absent on older servers. */
export type IntegrationsView = { providers: IntegrationProvider[]; categories?: IntegrationCategory[]; redirect_uri: string; local: LocalDisk }
/** One Google Calendar event as viewer/workspace._event returns it. `start`/`end`
 *  are RFC 3339 datetimes, or YYYY-MM-DD dates when `all_day`. */
export type CalendarEvent = {
  id: string; title: string; start: string; end: string; all_day: boolean
  location: string; description: string; attendees: string[]; link: string; status: string
}
export type CalendarWindow = { calendar: string; time_zone: string; from: string; to: string; events: CalendarEvent[] }
/** The fields an editor may send; omitted fields stay as they are on update. */
export type EventFields = Partial<Pick<CalendarEvent, "title" | "start" | "end" | "all_day" | "location" | "description" | "attendees">>
export type SessionSummary = {
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
}
export type AgentInfo = {
  id: string
  label: string
  vendor?: string
  installed: boolean
  loggedIn?: boolean
  docs?: string
}
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypass"
export type PermApproval = { id: string; tool_name: string; input: unknown }
/** GET /api/session-meta: stored per-chat settings plus Trust (saved permission
 *  policy, level override "" = none, and the level that applies). Cheap — no transcript read. */
export type SessionMeta = { session?: string; goal?: string; systemPrompt?: string; avatar?: string; pinned?: string[]; cwd?: string
  permission_mode?: string; level?: string; effective_level?: string }
export type GitStatus = { repo: boolean; branch?: string; name?: string; remote?: string; root?: string; dirty?: number; ahead?: number | null; behind?: number | null }
// A saved custom LLM provider (OpenAI-compatible endpoint). apiKey is NEVER
// returned by the server — it stays on the box and is revealed only to the runner.
// `models`: the connection's known models, each with its own context window
// (owner override, else what the endpoint reports).
export type Provider = { id: string; name: string; baseUrl: string; model: string; models?: ModelRow[]; isDefault?: boolean }
// Capabilities: skills + MCP tools (mirrors the web /api/capabilities shape).
export type Skill = { name: string; description?: string; source: string; path: string; editable: boolean }
export type McpServer = { name: string; scope: string; transport: string; target: string; config: Record<string, unknown>; editable: boolean }
/** A chat's plugin. `agent` = in Harman's catalog, added/removed per chat (`included` =
 *  the chat's agent brings it by default); `machine` = enabled in Claude Code on the Mac. */
export type Plugin = { name: string; description?: string; source: "agent" | "machine"; included: boolean; active: boolean }
/** `agent`: the agent this chat was started from — where "Keep on agent" saves its setup. */
export type Capabilities = { skills: Skill[]; mcp: McpServer[]; plugins?: Plugin[]; agent?: { id: number; name: string } }
/** A marketplace entry (GET /api/market/mcp | /api/market/skills). MCP entries
 *  carry `install` (npm | pypi | remote, or null when only Docker/bundle exists)
 *  and the `inputs` the owner fills; skills carry `license` and a file count. */
export type MarketInput = { name: string; description: string; secret: boolean; required: boolean; default: string }
export type MarketItem = {
  id: string; title: string; description: string; repo: string
  version?: string; publisher?: string; install?: "npm" | "pypi" | "remote" | null; inputs?: MarketInput[]
  license?: string; files?: number
  /** A vetted publisher's own plugin (an MCP server plus its skills), listed first. */
  featured?: boolean
}
export type MarketPage = { items: MarketItem[]; cursor?: string }
/** An MCP install: `signin` names the servers that still need the owner's OAuth sign-in. */
export type MarketInstalled = { installed: string; scope: string; skills?: string[]; signin?: string[] }
/** One OAuth sign-in to an MCP server, driven on the viewer's machine. */
export type McpSignin = { name: string; stage: "idle" | "starting" | "url" | "done" | "error"; url: string | null; error: string }
/** kind "once" = a one-shot that fires at nextRun and then retires; "recurring"
 *  (the default) follows cron or interval. */
export type Job = { id: string; session: string; prompt: string; interval: number; cron?: string; kind?: "recurring" | "once"; nextRun?: number; runs?: number; enabled?: boolean; provider?: string }
/** Harman (org) authority, server-enforced on every board/org action whatever the
 *  harness: ic < lead < manager (viewer/orglogic.LEVELS). Separate from the
 *  harness PermissionMode, which gates the CLI's own tools inside a run. */
export type HarmanLevel = "ic" | "lead" | "manager"
export type AgentTemplate = {
  id: number; name: string; description: string; category: string; icon: string
  system_prompt: string; goal: string
  /** The AI its chats run on; null = the owner's AI defaults. */
  ai?: AISelection | null
  /** The scheduled jobs a chat started from this agent begins with. */
  jobs?: NewChatJob[]
  /** Bundled role skills (viewer/agent_plugins/<plugin>) and the project
   *  lens it turns on ("map"); both are read server-side from the template row. */
  plugin?: string; lens?: string
  /** Harman authority a chat started from this role acts at on the board. */
  level?: HarmanLevel
  is_builtin: boolean; created_by: string; created_at: number
  /** Set = a personal agent only that user sees; null = shared/built-in. */
  owner_user_id?: number | null
  /** Catalog plugins a chat started from it gets ("Keep on agent"). */
  plugins?: string[] | null
  /** The server's answer to "may this caller edit/delete it". */
  editable?: boolean
}
/** What a person sets on an agent (viewer/db.TEMPLATE_FIELDS). */
export type AgentTemplateFields = Pick<AgentTemplate, "name" | "description" | "category" | "icon" | "system_prompt" | "goal" | "jobs" | "plugin" | "lens" | "level"> & { ai: AISelection | null; plugins: string[] }
/** GET /api/agent-templates/extras: the plugin catalog an agent picks from, and
 *  the skills and MCP servers saved on the agent itself (empty for a new one). */
export type AgentExtras = { catalog: { name: string; description: string }[]; skills: Skill[]; mcp: McpServer[] }
export type PendingQuestion = { tool_use_id: string; questions: unknown }
export type PendingPlan = { tool_use_id: string; plan: string; host?: string }
// ---- org / Kanban (the "empire") ----
export type OrgProject = { id: number; name: string; description: string; host: string; cwd: string; created_by: string; created_at: number; lenses?: string[] }
export type BoardColumn = { id: number; name: string; position: number }
/** One node of the Map lens (GET /api/org/map): a folder (id ends in "/"),
 *  a file, or a class/function inside one. `touched` = an agent wrote it lately. */
export type MapNode = {
  id: string; kind: "folder" | "file" | "class" | "function" | "method"; label: string
  files: number; symbols: number; touched: boolean; line?: number
}
export type MapLevel = "project" | "folder" | "file"
/** One level of a project's code as a graph; `available: false` means the
 *  server lacks the tree-sitter grammars (`install` says how to add them). */
export type MapView =
  | { available: false; level: MapLevel; path: string; install: string }
  | { available: true; project: number; level: MapLevel; path: string; files: number; mermaid: string
      nodes: MapNode[]; edges: { from: string; to: string; weight: number }[]
      touched: Record<string, string>; truncated: boolean }
/** One row of the cross-session decision queue (GET /api/decisions/open): a
 *  durable question, a durable plan, or a live tool approval. The queue is a
 *  READ of the existing sources — deciding an item uses the per-session
 *  routes, never this shape. */
export type OpenDecision = {
  /** "red" is an org approval: an agent's Red action (delete, bypass mode,
   *  restart…) queued for the owner; decided with orgResolveApproval. */
  kind: "question" | "plan" | "approval" | "card" | "red"
  session: string
  host: string
  label: string
  waiting_s: number
  summary: string
  question_count?: number
  tool_use_id?: string
  run_id?: string
  revision?: number
  tool_name?: string
  id?: string
  /** kind "red": the queued action, who asked, and what approving it does. */
  action?: string
  requested_by?: string
  risk?: string
  /** kind "red": the asker's own one line on why it needs this ("" on old rows). */
  reason?: string
  /** kind "card": the board card parked in Review/Needs-info for the owner. */
  card?: number
  column?: string
  /** The item's inbox row (0 when none was delivered) — the handle a snooze
   *  takes. The queue already omits items whose snooze is live. */
  inbox_id: number
  snoozed_until: number
}
export type Card = { id: number; title: string; body: string; column_id: number | null; project_id: number | null; session_id: string | null; position: number; created_by: string; created_at: number; updated_at: number; comment_count?: number }
export type CardComment = { id: number; card_id: number; author: string; body: string; created_at: number }
export type Approval = { id: number; kind: string; summary: string; detail: unknown; status: string; created_by: string; created_at: number; resolved_at?: number; resolution?: string }
export type CardFilter = { session?: string; project?: number }
// A note: the org's knowledge ledger next to the board (server: viewer/db notes).
// `kind` is its template; `archived` follows the owning chat's archive flag.
export type NoteKind = "note" | "journal" | "meeting" | "idea" | "checklist" | "discussion"
// replies / last_reply_at: the discussion thread's stats, on the list read only.
export type Note = { id: number; title: string; body: string; kind: NoteKind; project_id: number | null; session_id: string | null; pinned: boolean; archived: boolean; created_by: string; created_at: number; updated_at: number; replies?: number; last_reply_at?: number | null }
// One comment of a note's discussion, nested + sorted by the server (viewer/discussion.thread).
export type NoteComment = { id: number; note_id: number; parent_id: number | null; author: string; session_id: string; body: string; created_at: number; score: number; my_vote: -1 | 0 | 1; replies: NoteComment[] }
export type NoteCommentSort = "best" | "new" | "old"
export type NoteFilter = { session?: string; project?: number; archived?: boolean }
// ---- inbox (the channel: you ↔ owner ↔ peer sessions) ----
// A row of the message ledger. `kind` is "message" for a free message, or a
// decision kind (question | plan | approval | card | red) that was auto-delivered
// from its durable source — the inbox is a delivery SURFACE, never a second
// decision system. `open` is derived at read time from the live sources; a
// lapsed snooze re-reads as unread, so a skipped decision resurfaces.
export type InboxKind = "message" | "question" | "plan" | "approval" | "card" | "red"
export type InboxStatus = "sent" | "read" | "snoozed"
export type InboxMessage = {
  id: number
  session_id: string
  project_id: number | null
  sender_type: string
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
  /** Derived at read time: the row's decision is still open in its source. */
  open?: boolean | null
  effective_status?: InboxStatus
  snoozed?: boolean
  /** Client-only: an optimistic row the server has not acknowledged yet. */
  pending?: boolean
}
export type InboxFilter = { session?: string; project?: number; kind?: InboxKind; unread_only?: boolean; archived?: boolean }
/** A Red action the caller wasn't allowed to self-approve comes back as an OPEN
 *  APPROVAL, not the resource — `{queued, approval}` at status **200** (see
 *  viewer/actions.py execute). Any org write can return this, so writes whose
 *  action is Red are typed `T | Queued`: the compiler then forces the call site
 *  to decide, instead of letting a queued request read as a completed one. */
export type Queued = { queued: true; approval: number }
export const isQueued = (r: unknown): r is Queued =>
  !!r && (r as Queued).queued === true
/** `automation_enabled` is the master switch (default off): while it is off NOTHING
 *  runs unattended — not Harman's manager tick, not scheduled loops. `enabled`
 *  scopes only the manager tick, so it is meaningless while the master is off.
 *
 *  OPTIONAL on purpose: a server older than the switch omits the key entirely, and
 *  `undefined` must not collapse to `false` there — that server has no gate at all,
 *  so showing "off" would promise a pause that isn't happening. Callers must treat a
 *  missing value as *unknown*, never as off. */
export type HarmanConfig = { automation_enabled?: boolean }
/** WHICH loop origins may fire, orthogonal to the automation master switch:
 *  user = the owner's own scheduled loops only (the default), harman = agent-created
 *  loops only, both = every loop, none = paused. Governs loop firing alone; it does
 *  NOT start Harman's manager tick (that is `automation_enabled`). */
export type LoopMode = "user" | "harman" | "both" | "none"
export type LoopControl = { mode: LoopMode }
/** One row of the team skill library (/api/org/skills): every SKILL.md on disk joined with
 *  the learned-skill ledger. Ledger fields are absent for a hand-written/installed skill;
 *  status "missing" means a ledger row whose file is gone. */
export type LearnedSkill = { id?: number; name: string; path: string; description?: string; origin_card?: number | null; origin_session?: string | null; status: string; created_at?: number }
export type ChatStatus = {
  running?: boolean
  idle?: boolean
  queue?: string[]
  turns?: number
  steered?: number
  interrupted?: boolean
  pending_approvals?: PermApproval[]
  /** A parked AskUserQuestion awaiting the user's answer (async — the run ended). */
  pending_question?: PendingQuestion | null
  /** A proposed plan (ExitPlanMode) awaiting Approve/Deny. */
  pending_plan?: PendingPlan | null
}
export type Session = {
  id: string
  title?: string
  path: string
  project?: string
  modified?: number
  /** When the last visible message was written (epoch s). The file's mtime
   *  (`modified`) also moves when Claude Code appends bookkeeping on resume or
   *  exit, so lists sort and show this instead; older servers omit it. */
  last_message?: number
  size?: number
  /** Emoji avatar chosen on the Session profile page (overlaid server-side). */
  avatar?: string
  /** Server-side flags (session meta): archived hides from the main list; favorite pins. */
  archived?: boolean
  favorite?: boolean
  /** Last visible message, "You: …"-prefixed for user turns (chat-list preview). */
  preview?: string
  /** Server-authoritative unread bit for THIS reader (principal), not per-device:
   *  true when a message arrived since this reader last opened it. */
  unread?: boolean
  /** Live run flag: a run is in flight for this session. Per-viewer-process truth
   *  (the jobs THIS viewer started), not a cross-host guarantee. */
  running?: boolean
}

async function req<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Awaited<ReturnType<typeof serverFetch>>
  try {
    res = await serverFetch(
      method,
      path,
      { "Content-Type": "application/json" },
      body === undefined ? undefined : JSON.stringify(body)
    )
  } catch (e) {
    if (isTransportError(e)) reachability.report(false)
    throw e
  }
  // Any HTTP reply, even an error status, proves the server is reachable.
  reachability.report(true)
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  if (!res.ok) {
    // The org gate refuses with `{denied, reason}` rather than `{error}` (see
    // viewer/actions.py execute), so read both — otherwise every authority
    // refusal reaches the UI as a bare "HTTP 403" with the reason discarded.
    const d = data as { error?: string; reason?: string }
    const msg = d?.error || d?.reason || `HTTP ${res.status}`
    const err = new Error(msg) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return data as T
}


type RawPage = { lines?: string[]; start?: number; end?: number; size?: number }
export type SessionPage = { lines: string[]; start: number; end: number; size: number }
const toPage = (env: RawPage | null): SessionPage => ({
  lines: Array.isArray(env?.lines) ? env.lines : [],
  start: env?.start ?? 0,
  end: env?.end ?? env?.size ?? 0,
  size: env?.size ?? 0,
})

export const api = {
  // ---- auth ----
  authState: () => req<{ signupOpen: boolean; user: User | null }>("GET", "/api/auth/state"),
  me: () => req<{ user: User | null }>("GET", "/api/auth/me"),
  signin: (username: string, password: string) =>
    req<{ user: User; token?: string }>("POST", "/api/auth/signin", { username, password, wantToken: true }),
  signup: (username: string, password: string, setupCode: string) =>
    req<{ user: User; token?: string }>("POST", "/api/auth/signup", { username, password, setupCode, wantToken: true }),
  // Redeem a one-time code from the web's "Pair a phone" QR for a session token.
  pairRedeem: (code: string) => req<{ user: User; token: string }>("POST", "/api/auth/pair/redeem", { code }),
  signout: () => req("POST", "/api/auth/signout", {}),

  // ---- push notifications ----
  // Register this device's Expo push token so the server can notify us in the
  // background (turn finished / approval needed). Unregister on logout.
  // `app` declares what this client runs (version + native build number from
  // the embedded Info.plist) so the server can see which build is on a device.
  pushRegister: (
    token: string,
    platform = "ios",
    app: { version?: string | null; build?: string | null } = {},
  ) =>
    req<{ registered?: boolean; error?: string }>("POST", "/api/push/register", {
      token,
      platform,
      app_version: app.version || null,
      app_build: app.build || null,
    }),
  pushUnregister: (token: string) =>
    req<{ unregistered?: boolean }>("POST", "/api/push/unregister", { token }),

  // ---- hosts ----
  hosts: () => req<Host[]>("GET", "/api/hosts"),

  // ---- sessions ----
  sessions: (host: string) =>
    req<Session[]>("GET", `/api/sessions?host=${encodeURIComponent(host)}`),
  // Mark a session read for this reader (advances the server-side unread cursor).
  // Fire-and-forget from the UI; the next list refresh reflects unread=false.
  sessionSeen: (path: string) =>
    req<{ seen?: boolean }>("POST", "/api/session/seen", { session: path }),
  // Transcript records (last `tail` lines). Mirrors web api.sessionReadTail —
  // `path` is inserted unencoded so the server's /api/session/<path> wildcard
  // route matches, exactly as the web client does. The server responds with a
  // JSON envelope {start,end,size,lines:[...]}; we return the `lines` array
  // (each entry is one JSONL transcript record).
  sessionRead: async (host: string, path: string, tail = 400): Promise<string[]> =>
    (await api.sessionReadPage(host, path, tail)).lines,
  // Like sessionRead but returns the paging envelope too: `start` is the byte
  // offset of the first returned line (0 ⇒ we've reached the top of the file, so
  // there's no older history to load). Used by the thread to grow its window when
  // the user scrolls up.
  sessionReadPage: async (
    host: string,
    path: string,
    tail = 400
  ): Promise<SessionPage> => {
    const q = new URLSearchParams({ tail: String(tail) })
    if (host && host !== "local") q.set("host", host)
    return toPage(await req<RawPage | null>("GET", `/api/session/${path}?${q.toString()}`))
  },
  // Incremental read: only the lines appended after byte offset `from` (the
  // previous page's `end`). A running thread polls this instead of re-reading
  // its whole tail window — bytes scale with new output, not transcript size.
  sessionReadFrom: async (host: string, path: string, from: number): Promise<SessionPage> => {
    const q = new URLSearchParams({ from: String(from) })
    if (host && host !== "local") q.set("host", host)
    return toPage(await req<RawPage | null>("GET", `/api/session/${path}?${q.toString()}`))
  },
  // Start a brand-new agent session in `cwd`. Returns the new session id plus the
  // transcript path, which the thread screen opens directly.
  newSession: (body: {
    message: string
    cwd?: string
    mode?: string
    model?: string
    host?: string
    agent?: string
    title?: string
    systemPrompt?: string
    goal?: string
    effort?: string
    ai?: AISelection
    template?: number
    /** Scheduled jobs saved with the chat, server-side, in the same request. */
    jobs?: { prompt: string; cron?: string; interval?: number; at?: string }[]
  }) => req<{ started: boolean; session: string; path?: string; jobs?: string[] }>("POST", "/api/new-session", { ...body, model: normModel(body.model) }),
  // Resolve a session id to its transcript path (polls until Claude creates the JSONL).
  resolve: (id: string, host?: string) =>
    req<{ found: boolean; path?: string; running?: boolean; error?: string }>(
      "GET",
      `/api/resolve?id=${encodeURIComponent(id)}${host && host !== "local" ? `&host=${encodeURIComponent(host)}` : ""}`
    ),
  // Distinct working directories seen across sessions — the cwd suggestions.
  // Server returns [{cwd, modified}], newest first.
  projects: (host: string) =>
    req<Project[]>(
      "GET",
      `/api/projects${host && host !== "local" ? `?host=${encodeURIComponent(host)}` : ""}`
    ),

  // ---- drive a session ----
  // Body shape mirrors web/ store.ts: { path, message, mode, model, agent, host }.
  chat: (body: {
    message: string
    path?: string
    mode?: string
    model?: string
    agent?: string
    host?: string
    queue?: boolean
  }) => req<ChatResult>("POST", "/api/chat", { ...body, model: normModel(body.model) }),
  chatStatus: (id: string) => req<ChatStatus>("GET", `/api/chat/status?id=${encodeURIComponent(id)}`),
  // One spoken exchange with the fast call brain. It answers in ~1-2 s: small talk
  // itself, real work handed to the session at `path` as a background turn (the
  // brain's ask_harman/check_harman/board_status tools). `history` is opaque —
  // echo the returned one back on the next turn; the server keeps no call state.
  callEngine: () => req<CallEngine>("GET", "/api/call/engine"),
  callTurn: (body: { path: string; text: string; history: CallHistory }) =>
    req<{ reply: string; history: CallHistory; tools: string[] }>("POST", "/api/call/turn", body),
  // The server derives the session id from `path` (via sid_from_path, which also
  // accepts a bare id). Send `path` to match — sending `session` is ignored and
  // yields "Session and message required".
  chatInterrupt: (path: string) => req("POST", "/api/chat/interrupt", { path }),
  // Inject a message into a turn that's already running (mid-flight steer).
  chatSteer: (body: { path: string; message: string; host?: string }) =>
    req("POST", "/api/chat/steer", body),
  // Answer a per-call MCP tool approval (the B-true bridge): allow/deny.
  chatPermissionDecide: (body: { session: string; id: string; decision: "allow" | "deny" }) =>
    req("POST", "/api/chat/permission/decide", body),
  // Answer a parked AskUserQuestion (async): the server resolves the pending row
  // and RESUMES the session with the picks. `picks` are option labels aligned to
  // the questions; `note` is the owner's typed reply (alone or with picks).
  // Returns {resumed:true} once the resumed run starts.
  chatQuestionAnswer: (body: { session: string; picks: string[]; note?: string; mode?: string; model?: string }) =>
    req<{ resumed?: boolean; answered?: boolean; session?: string; error?: string }>("POST", "/api/chat/question/answer", body),
  // Approve or deny a proposed plan (ExitPlanMode). Deny may carry revision
  // feedback the agent uses to re-plan. Same-turn (the run is blocked waiting).
  chatPlanDecide: (body: { session: string; decision: "approve" | "deny"; feedback?: string }) =>
    req<{ decided?: boolean; session?: string; error?: string }>("POST", "/api/chat/plan/decide", body),
  // Drop a message from the pending queue by its index.
  chatQueueRemove: (body: { path: string; index: number }) =>
    req<{ removed: string | null }>("POST", "/api/chat/queue/remove", body),

  // ---- session management ----
  renameSession: (body: { session: string; title: string; host?: string; agent?: string }) =>
    req<{ renamed: boolean; title: string }>("POST", "/api/session/rename", body),
  deleteSession: (body: { session: string; host?: string; agent?: string }) =>
    req("POST", "/api/session/delete", body),
  forkSession: (body: { session: string; uuid: string; host?: string; agent?: string }) =>
    req("POST", "/api/session/fork", body),
  // Revert: rewind the session to just before `uuid`. mode "conversation" drops
  // the messages only; "code" also restores files; "code+conversation" does both.
  restoreSession: (body: {
    session: string
    uuid: string
    mode?: "conversation" | "code" | "code+conversation"
    host?: string
    agent?: string
  }) => req("POST", "/api/session/restore", body),

  // ---- session stats ----
  sessionSummary: (host: string, session: string) =>
    req<SessionSummary>(
      "GET",
      `/api/session-summary?session=${encodeURIComponent(session)}` +
        (host && host !== "local" ? `&host=${encodeURIComponent(host)}` : "")
    ),

  // ---- git status for a session's working dir (host-aware) ----
  gitStatus: (host: string, cwd: string) =>
    req<GitStatus>(
      "GET",
      `/api/git/status?cwd=${encodeURIComponent(cwd)}` +
        (host && host !== "local" ? `&host=${encodeURIComponent(host)}` : "")
    ),

  sessionModeSet: (session: string, mode: PermissionMode) =>
    req<{ session?: string; permission_mode?: PermissionMode; error?: string; queued?: boolean; denied?: boolean; reason?: string }>(
      "POST", "/api/session/mode", { for_session: session, mode }
    ),
  /** Set the session's Harman level ("" clears it back to the level of the agent it was started from).
   *  Red: from the app the owner's tap applies; anyone else's queues. */
  sessionLevelSet: (session: string, level: HarmanLevel | "") =>
    req<{ session?: string; level?: string; error?: string; queued?: boolean; denied?: boolean; reason?: string }>(
      "POST", "/api/session/level", { for_session: session, level }
    ),

  // ---- per-session metadata (system prompt + goal), mirrors web api.sessionMeta ----
  sessionMeta: (host: string, session: string) =>
    req<SessionMeta>(
      "GET",
      `/api/session-meta?session=${encodeURIComponent(session)}` +
        (host && host !== "local" ? `&host=${encodeURIComponent(host)}` : "")
    ),
  sessionMetaSave: (body: { session: string; goal?: string; systemPrompt?: string; avatar?: string; archived?: boolean; favorite?: boolean; pinned?: string[]; host?: string }) =>
    req<{ ok?: boolean }>("POST", "/api/session-meta", body),

  // ---- custom LLM providers (OpenAI-compatible endpoints). The apiKey is sent
  //      on save but never returned; /models is fetched server-side so the key
  //      never touches the device. ----
  providers: () => req<{ providers: Provider[] }>("GET", "/api/providers"),
  aiConfig: (scope: { id?: string; host: string; agent?: string }, selection?: AISelection) =>
    req<AIConfig>("GET", `${scope.id ? "/api/session/ai" : "/api/ai/defaults"}?${new URLSearchParams({ host: scope.host, agent: scope.agent || "claude", ...(scope.id ? { id: scope.id } : {}), ...(selection ? { provider: selection.provider, convMode: selection.convMode } : {}) })}`),
  aiSave: (scope: { id?: string; host: string; agent?: string }, revision: number, selection: AISelection) =>
    req<AIConfig>("POST", scope.id ? "/api/session/ai" : "/api/ai/defaults", { ...scope, agent: scope.agent || "claude", revision, selection }),
  providerSave: (body: { id?: string; name: string; baseUrl: string; model: string; apiKey?: string; apiKeyAction?: KeyAction; modelOverrides: Record<string, number> }) =>
    req<Provider & { error?: string }>("POST", "/api/providers", body),
  providerDelete: (id: string) => req<{ deleted?: boolean }>("POST", "/api/providers/delete", { id }),
  providerDefault: () => req<{ id: string }>("GET", "/api/providers/default"),
  providerModels: (q: { id: string }) =>
    req<ModelDiscovery>("GET", `/api/providers/models?${new URLSearchParams(q)}`),
  providerDraftModels: (draft: ConnectionDraft) =>
    req<ModelDiscovery>("POST", "/api/providers/models", draft),

  // ---- capabilities: skills + MCP tools (host-aware), mirrors web api ----
  // `session` (the session rel path) lets the server add the session's attached
  // agent-template plugin skills — they run via --plugin-dir but live outside the
  // scanned skill roots, so without the session they'd be invisible here.
  capabilities: (host: string, cwd?: string, session?: string) =>
    req<Capabilities>(
      "GET",
      `/api/capabilities?${new URLSearchParams({
        ...(host && host !== "local" ? { host } : {}),
        ...(cwd ? { cwd } : {}),
        ...(session ? { session } : {}),
      }).toString()}`
    ),
  skill: (host: string, path: string) =>
    req<{ content?: string; error?: string }>(
      "GET",
      `/api/skill?path=${encodeURIComponent(path)}` + (host && host !== "local" ? `&host=${encodeURIComponent(host)}` : "")
    ),
  skillSave: (body: { name: string; content: string; scope?: string; cwd?: string; host?: string; session?: string }) =>
    req<{ saved?: boolean; path?: string; error?: string }>("POST", "/api/skill/save", body),
  skillDelete: (body: { path: string; host?: string }) =>
    req<{ deleted?: boolean; error?: string }>("POST", "/api/skill/delete", body),
  mcpSave: (body: { name: string; scope?: string; config: Record<string, unknown>; cwd?: string; host?: string; session?: string }) =>
    req<{ saved?: boolean; error?: string }>("POST", "/api/mcp/save", body),
  mcpDelete: (body: { name: string; scope?: string; cwd?: string; host?: string; session?: string }) =>
    req<{ deleted?: boolean; error?: string }>("POST", "/api/mcp/delete", body),
  /** Add (on) or remove one Harman plugin for a chat; returns the chat's plugin list. */
  chatPlugin: (body: { session: string; name: string; on: boolean }) =>
    req<{ plugins: string[] }>("POST", "/api/chat/plugin", body),
  /** Keep this chat's plugins, skills and MCP on the agent it was started from. */
  chatSaveToAgent: (session: string) =>
    req<{ saved: boolean; plugins: string[] }>("POST", "/api/chat/save-to-agent", { session }),
  // Marketplace: the server rebuilds every install from the source's own record;
  // the app names an entry id, never a command. Installs land on this machine.
  marketMcp: (q: string, cursor?: string) =>
    req<MarketPage>("GET", `/api/market/mcp?${new URLSearchParams({ q, ...(cursor ? { cursor } : {}) })}`),
  marketSkills: (q: string) => req<MarketPage>("GET", `/api/market/skills?${new URLSearchParams({ q })}`),
  marketMcpInstall: (body: { id: string; values: Record<string, string>; scope: "global" | "project" | "chat" | "agent"; cwd?: string; session?: string; agent?: number }) =>
    req<MarketInstalled>("POST", "/api/market/mcp/install", body),
  /** Sign in to an OAuth MCP server at the scope it was installed at. */
  mcpSigninStart: (body: { name: string; scope: "global" | "project" | "chat" | "agent"; cwd?: string; session?: string; agent?: number }) =>
    req<McpSignin>("POST", "/api/market/mcp/signin/start", body),
  mcpSignin: () => req<McpSignin>("GET", "/api/market/mcp/signin"),
  mcpSigninSubmit: (redirect: string) => req<McpSignin>("POST", "/api/market/mcp/signin/submit", { redirect }),
  mcpSigninCancel: () => req<McpSignin>("POST", "/api/market/mcp/signin/cancel"),
  marketSkillInstall: (body: { id: string; scope: "user" | "project" | "chat" | "agent"; cwd?: string; session?: string; agent?: number }) =>
    req<{ installed: string; scope: string }>("POST", "/api/market/skill/install", body),

  // ---- scheduled jobs (re-run a prompt on a schedule), server API still named "loops" ----
  loops: (sessionId: string) => req<Job[]>("GET", `/api/loops?session=${encodeURIComponent(sessionId)}`),
  // Schedule precedence is the server's: cron > at (one-shot ISO datetime) > interval.
  loopsCreate: (body: { session: string; prompt: string; interval?: number; cron?: string; at?: string; model?: string; provider?: string }) =>
    req<{ created?: string; error?: string }>("POST", "/api/loops", body),
  loopsEdit: (body: { id: string; prompt?: string; interval?: number; cron?: string; at?: string; model?: string; enabled?: boolean; provider?: string }) =>
    req<{ updated?: string }>("POST", "/api/loops/edit", body),
  loopsDelete: (id: string) => req("POST", "/api/loops/delete", { id }),

  // ---- agent templates (curated session presets) ----
  agentTemplates: () => req<AgentTemplate[]>("GET", "/api/agent-templates"),
  // Personal agents: the server checks ownership (built-ins are never edited — duplicate one).
  agentTemplateCreate: (body: AgentTemplateFields) =>
    req<{ id: number; template: AgentTemplate }>("POST", "/api/agent-templates", body),
  agentTemplateUpdate: (id: number, body: AgentTemplateFields) =>
    req<{ template: AgentTemplate }>("POST", "/api/agent-templates/update", { id, ...body }),
  agentTemplateDuplicate: (id: number) =>
    req<{ id: number; template: AgentTemplate }>("POST", "/api/agent-templates/duplicate", { id }),
  agentTemplateExtras: (id?: number) =>
    req<AgentExtras>("GET", `/api/agent-templates/extras${id ? `?id=${id}` : ""}`),
  /** Save or delete one skill or MCP server on an agent (its owner only).
   *  `from_path` copies an existing skill on this Mac (its SKILL.md path) whole. */
  agentTemplateExtra: (body: { id: number; kind: "skill" | "mcp"; name: string; content?: string; config?: Record<string, unknown>; from_path?: string; delete?: boolean }) =>
    req<{ saved: boolean }>("POST", "/api/agent-templates/extra", body),
  agentTemplateDelete: (id: number) => req<{ deleted: boolean }>("POST", "/api/agent-templates/delete", { id }),

  // ---- agents available on a host ----
  agents: (host: string) =>
    req<{ agents: AgentInfo[] }>(
      "GET",
      `/api/agents${host && host !== "local" ? `?host=${encodeURIComponent(host)}` : ""}`
    ),

  // ---- filesystem browser (local / SSH host / cloud drive) ----
  // Every call is scoped by `scope` — {host} for an SSH host, {drive} for a
  // cloud drive, {} for this machine — built by lib/location.ts#fsScope so the
  // "exactly one of host/drive" rule the server enforces lives in one place.
  fs: (scope: FsScope, path: string, hidden = false) =>
    req<FileList>(
      "GET",
      `/api/fs?${new URLSearchParams({ path, hidden: hidden ? "1" : "0", ...scope })}`
    ),

  // The composer's "#" picker: fuzzy-ranked files and folders of a project.
  fsSearch: (host: string, cwd: string, q: string) =>
    req<{ results: { path: string; dir: boolean }[] }>(
      "GET",
      `/api/fs/search?${new URLSearchParams({ cwd, q, ...(host && host !== "local" ? { host } : {}) })}`
    ),

  // Create a folder. `name` must be a single segment (server rejects slashes).
  fsMkdir: (scope: FsScope, body: { path: string; name: string }) =>
    req<{ error?: string }>("POST", "/api/fs/mkdir", { ...body, ...scope }),

  // Delete a file/folder (server moves it to a reversible trash dir; a drive
  // adapter trashes it vendor-side).
  fsDelete: (scope: FsScope, body: { path: string }) =>
    req<{ deleted?: string; error?: string }>("POST", "/api/fs/delete", { ...body, ...scope }),

  // Upload a local file into `dir` as one multipart part; the server parses
  // the body into (filename, bytes) — see _p_fs_upload. Returns the server's
  // reply (`uploaded` holds the absolute paths written).
  fsUpload: async (scope: FsScope, dir: string, uri: string, name: string, mime?: string) => {
    const q = new URLSearchParams({ path: dir, ...scope })
    const res = await serverUpload(`/api/fs/upload?${q.toString()}`, {
      uri,
      name,
      type: mime || "application/octet-stream",
      field: "file",
    })
    let data: { uploaded?: unknown[]; error?: string } | null = null
    try {
      data = JSON.parse(await res.text())
    } catch {
      /* not JSON */
    }
    if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`)
    return data
  },

  // Save a file to `dest` on this phone (to share it onward). Resolves the HTTP
  // status; on an error status `dest` holds the server's JSON error body.
  fsDownload: (scope: FsScope, path: string, dest: string): Promise<number> =>
    serverDownload(`/api/fs/download?${new URLSearchParams({ path, ...scope }).toString()}`, dest),

  // ---- cloud drives (the Files screen's third location) ----
  // Every drive the location picker can offer (sanitized — no tokens) plus the
  // vendors a NEW drive may be created for.
  drives: () => req<{ drives: Drive[]; vendors: string[] }>("GET", "/api/drives"),
  // Create an empty drive row, then connect it via driveOAuthStart.
  driveCreate: (body: { label: string; kind: string }) =>
    req<{ drive: Drive }>("POST", "/api/drives", body),
  // Remove a drive and its stored tokens; the vendor-side files are untouched.
  driveDelete: (id: string) => req<{ ok?: boolean; error?: string }>("POST", "/api/drives/delete", { drive: id }),
  // Begin the hosted consent flow: the vendor URL to open in the system browser
  // and the pending handle to poll. The vendor sends the browser back to the
  // server's /api/drive/oauth/callback, which finishes the exchange, so the
  // app only waits for `status` to flip.
  driveOAuthStart: (drive: string) =>
    req<{ url: string; pending: string } | { error: string }>("POST", "/api/drive/oauth/start", { drive }),
  driveOAuthStatus: (pending: string) =>
    req<{ status: "waiting" | "authorized" | "failed" | "expired"; error?: string }>(
      "GET", `/api/drive/oauth/status?pending=${encodeURIComponent(pending)}`
    ),
  // ---- integrations (accounts + the services agents may use on them) ----
  integrations: () => req<IntegrationsView>("GET", "/api/integrations"),
  // Consent for `service` on `connection` (adds the permission, keeps the
  // rest) or, without one, on a new account. Poll with driveOAuthStatus.
  // `op` asks for that operation's extra scopes too (e.g. calendar editing).
  integrationConnect: (body: { service: string; connection?: string; op?: string }) =>
    req<{ url: string; pending: string; connection: string }>("POST", "/api/integrations/connect", body),
  // The owner's on/off switch for a granted service; returns the fresh view.
  /** Connect a token provider (or, with `connection`, replace that account's
   *  token). The server checks it with the vendor before saving. */
  integrationToken: (body: { provider: string; token: string; fields?: Record<string, string>; connection?: string }) =>
    req<IntegrationsView>("POST", "/api/integrations/token", body),
  integrationService: (body: { connection: string; service: string; on: boolean }) =>
    req<IntegrationsView>("POST", "/api/integrations/service", body),
  // Harman's own OAuth client per provider. The secret is write-only: a save
  // without client_secret keeps the stored one; "" clears it.
  // Allow/disallow one operation for agents on one account (409 if never granted).
  integrationOp: (body: { connection: string; service: string; op: string; on: boolean }) =>
    req<IntegrationsView>("POST", "/api/integrations/op", body),
  // Narrow a files account to one existing folder ("/" = the whole account).
  integrationRoot: (body: { connection: string; root: string }) =>
    req<IntegrationsView>("POST", "/api/integrations/root", body),
  // The folders agents may touch on this machine, and what they may do there.
  integrationLocal: (body: { roots: string[]; ops: string[] }) =>
    req<IntegrationsView>("POST", "/api/integrations/local", body),
  integrationClientSave: (body: { provider: string; client_id: string; client_secret?: string }) =>
    req<IntegrationsView>("POST", "/api/integrations/client", body),
  integrationClientDelete: (provider: string) =>
    req<IntegrationsView>("POST", "/api/integrations/client/delete", { provider }),
  // ---- calendar (the owner's own Google Calendar; the server answers 403 with
  // a "connect it in Integrations" message when a grant is missing) ----
  calendarEvents: (q: { start?: string; end?: string; q?: string; connection?: string } = {}) =>
    req<CalendarWindow>("GET", "/api/calendar/events?" + new URLSearchParams(
      Object.entries(q).filter(([, v]) => v) as [string, string][]).toString()),
  calendarCreate: (fields: EventFields, connection?: string) =>
    req<CalendarEvent>("POST", "/api/calendar/create", { ...fields, connection }),
  calendarUpdate: (id: string, fields: EventFields, connection?: string) =>
    req<CalendarEvent>("POST", "/api/calendar/update", { ...fields, id, connection }),
  calendarDelete: (id: string, connection?: string) =>
    req<{ deleted: string }>("POST", "/api/calendar/delete", { id, connection }),

  // ---- voice (call listening + text-to-speech) ----
  // Spoken text as an AAC stream (Pocket generate_audio_stream -> ffmpeg).
  // Direct, track-player streams the URL (first audio in ~0.5s even for a
  // long reply); through the relay it is fetched into `dest` first.
  voiceTts: (text: string, dest: string) =>
    serverMedia(`/api/voice/tts/stream?text=${encodeURIComponent(text)}`, dest),
  // Call listening socket. The app streams endpointed utterances (binary
  // frames); the server transcribes each on the GPU box and pushes back
  // {type:"utterance",text}. mode=call: the call itself is the "talking to you"
  // signal, so there is no per-turn wake word.
  voiceSocket: () => serverSocket("/api/voice/ws?mode=call"),

  // ---- Nemotron voicechat (call audio, turn-based) ----
  // GET /api/voice/nemotron/status -> the GPU service's /health passed through
  // (see viewer.nemotron.status). Always 200 in the normal/disabled case; only a
  // configured-but-broken backend returns 502 with `error` set. `ready:false`
  // while idle is EXPECTED (the model loads per call). Consulted only AFTER
  // callEngine chose "nemotron" — it never decides the engine.
  nemotronStatus: () => req<NemotronStatus>("GET", "/api/voice/nemotron/status"),
  // The one Nemotron call socket for a session. `kind:"ready"` arrives once
  // the model loaded for this call — never send audio before it. Binary
  // replies precede their turn_end frame.
  nemotronSocket: (path: string) => serverSocket(`/api/voice/nemotron/ws?path=${encodeURIComponent(path)}`),

  // Barge-in wake-guard socket: a lightweight keyword-spotting stream that runs
  // WHILE the assistant is speaking. The server uses a cheap KWS pass (not full
  // STT) so it can loop continuously; it fires only when the wake word "Harman"
  // is heard, returning the transcript tail for command parsing (stop / end /
  // new question).
  voiceWakeguardSocket: (speakerId = "default") =>
    serverSocket(`/api/voice/ws?speaker_id=${encodeURIComponent(speakerId)}&mode=wakeguard`),

  // ---- host management ----
  hostsSave: (cfg: {
    id?: string
    label: string
    host: string
    user: string
    port?: number
    auth?: "key" | "password"
    keyFile?: string
    password?: string
  }) => req<{ ok?: boolean; error?: string }>("POST", "/api/hosts/save", cfg),
  hostsTest: (cfg: Record<string, unknown>) => req<{ ok: boolean; message?: string }>("POST", "/api/hosts/test", cfg),
  hostsDelete: (id: string) => req("POST", "/api/hosts/delete", { id }),

  // ---- slash commands (composer autocomplete) ----
  commands: (host: string) =>
    req<SlashCommand[]>(
      "GET",
      `/api/commands${host && host !== "local" ? `?host=${encodeURIComponent(host)}` : ""}`
    ),

  // ---- terminal socket ----
  // Mirrors web/ TerminalPanel: binary output, JSON `{t:"i",d}` input,
  // `{t:"r",cols,rows}` resize. `local` host is implied by omitting the param.
  terminalSocket: (opts: { cols: number; rows: number; host?: string }) => {
    const p = new URLSearchParams({ cols: String(opts.cols), rows: String(opts.rows) })
    if (opts.host && opts.host !== "local") p.set("host", opts.host)
    return serverSocket(`/api/terminal/ws?${p.toString()}`)
  },

  // ---- org / Kanban (the "empire") ----
  orgProjects: () => req<{ projects: OrgProject[] }>("GET", "/api/org/projects"),
  orgCreateProject: (body: { name: string; description?: string; host?: string; cwd?: string }) =>
    req<OrgProject>("POST", "/api/org/projects", body),
  // A board's columns are per-project. Pass the project directly, or the
  // session and the server resolves that session's own project (bound at spawn).
  orgBoard: (filter: CardFilter = {}) => {
    const p = new URLSearchParams()
    if (filter.project !== undefined) p.set("project", String(filter.project))
    else if (filter.session !== undefined) p.set("session", filter.session)
    const q = p.toString()
    return req<{ columns: BoardColumn[] }>("GET", `/api/org/board${q ? "?" + q : ""}`)
  },
  // Scope is a project, or a session whose bound project the server resolves.
  orgMap: (scope: { project?: number; session?: string }, level: MapLevel, path = "") => {
    const p = new URLSearchParams({ level, path })
    if (scope.project !== undefined) p.set("project", String(scope.project))
    else if (scope.session) p.set("session", scope.session)
    return req<MapView>("GET", `/api/org/map?${p}`)
  },
  orgCards: (filter: CardFilter = {}) => {
    const p = new URLSearchParams()
    if (filter.session !== undefined) p.set("session", filter.session)
    if (filter.project !== undefined) p.set("project", String(filter.project))
    const q = p.toString()
    return req<{ cards: Card[] }>("GET", `/api/org/cards${q ? "?" + q : ""}`)
  },
  orgCreateCard: (body: { title: string; body?: string; column_id?: number; project_id?: number; session?: string; position?: number }) =>
    req<Card>("POST", "/api/org/cards", body),
  orgMoveCard: (body: { card_id: number; column_id: number; position: number }) =>
    req<Card>("POST", "/api/org/cards/move", body),
  orgUpdateCard: (body: { card_id: number; title?: string; body?: string; column_id?: number; project_id?: number; position?: number }) =>
    req<Card>("POST", "/api/org/cards/update", body),
  // `card_delete` and the automation resume are Red (viewer/orglogic), so these
  // two can come back queued instead of done — the union makes the caller say so.
  orgDeleteCard: (body: { card_id: number }) =>
    req<{ deleted?: boolean } | Queued>("POST", "/api/org/cards/delete", body),
  // The card's detail read: the card itself, its full comment thread, and its
  // move options — the columns of the board it can move on (its own project,
  // else its session's bound one; the server resolves, so an empty list means
  // the card is on no board yet and the detail screen offers to attach it).
  orgCard: (id: number) =>
    req<{ card: Card; comments: CardComment[]; columns?: BoardColumn[] }>("GET", `/api/org/card?id=${id}`),
  orgAddCardComment: (body: { card_id: number; body: string }) =>
    req<CardComment>("POST", "/api/org/card_comment", body),
  // ---- notes (the knowledge ledger; scoped like cards) ----
  orgNoteComments: (noteId: number, sort: NoteCommentSort = "best") =>
    req<{ comments: NoteComment[]; count: number }>("GET", `/api/org/note_comments?note_id=${noteId}&sort=${sort}`),
  orgNoteComment: (body: { note_id: number; body: string; parent_id?: number | null }) =>
    req<NoteComment>("POST", "/api/org/note_comment", body),
  // value 0 withdraws the reader's vote.
  orgNoteVote: (commentId: number, value: -1 | 0 | 1) =>
    req<{ comment_id: number; my_vote: number; score: number }>("POST", "/api/org/note_vote", { comment_id: commentId, value }),
  orgNotes: (filter: NoteFilter = {}) => {
    const p = new URLSearchParams()
    if (filter.session !== undefined) p.set("session", filter.session)
    if (filter.project !== undefined) p.set("project", String(filter.project))
    if (filter.archived) p.set("archived", "1")
    const q = p.toString()
    return req<{ notes: Note[] }>("GET", `/api/org/notes${q ? "?" + q : ""}`)
  },
  orgNote: (id: number) => req<{ note: Note }>("GET", `/api/org/note?id=${id}`),
  orgCreateNote: (body: { title: string; body?: string; kind?: NoteKind; project_id?: number; session?: string; pinned?: boolean }) =>
    req<Note>("POST", "/api/org/notes", body),
  orgUpdateNote: (body: { note_id: number; title?: string; body?: string; kind?: NoteKind; pinned?: boolean; archived?: boolean }) =>
    // relinked: a rename rewrote [[links]] in that many notes (viewer/notelinks.py)
    req<Note & { relinked?: number }>("POST", "/api/org/notes/update", body),
  /** How a project's notes link ([[Title]], #tags) — see lib/noteLinks.ts. */
  orgNotesGraph: (project?: number | null) =>
    req<NoteGraph>("GET", `/api/org/notes/graph${project ? `?project=${project}` : ""}`),
  /** The notes as an Obsidian vault (.zip of markdown) saved to `dest`; returns the HTTP status. */
  orgNotesExport: (project: number | null | undefined, dest: string) =>
    serverDownload(`/api/org/notes/export${project ? `?project=${project}` : ""}`, dest),
  orgNoteExport: (id: number, format: "md" | "docx" | "pdf", dest: string) =>
    serverDownload(`/api/org/note/export?id=${id}&format=${format}`, dest),
  // `note_delete` is Red: an agent's delete queues; the owner's runs.
  orgDeleteNote: (body: { note_id: number }) =>
    req<{ deleted?: boolean } | Queued>("POST", "/api/org/notes/delete", body),
  // The cross-session decision queue (card #60): every open durable question/
  // plan + live tool approval, oldest first, with a total count. Read-only —
  // deciding an item goes through the per-session routes, which are race-safe.
  openDecisions: () =>
    req<{ count: number; decisions: OpenDecision[] }>("GET", "/api/decisions/open"),
  // ---- inbox (the channel). The owner (app principal) may filter freely and
  //  gets the action queue; an agent (mcp) is pinned to its own mailbox and
  //  gets no queue — the server decides, not the client. Deciding an open
  //  decision goes through the per-session routes (the chat), never here.
  inboxList: (filter: InboxFilter = {}) => {
    const p = new URLSearchParams()
    if (filter.session) p.set("session", filter.session)
    if (filter.project !== undefined) p.set("project", String(filter.project))
    if (filter.kind) p.set("kind", filter.kind)
    if (filter.unread_only) p.set("unread_only", "1")
    if (filter.archived) p.set("archived", "1")
    const q = p.toString()
    return req<{ messages: InboxMessage[]; unread?: number; queue?: { count: number; items: InboxMessage[] } }>(
      "GET", `/api/inbox${q ? "?" + q : ""}`)
  },
  // Just the badge number — the full list is ~64 KB the badge would discard.
  inboxUnread: () => req<{ unread?: number }>("GET", "/api/inbox?count_only=1"),
  inboxSend: (body: { to: string; body: string; in_reply_to?: number }) =>
    req<InboxMessage>("POST", "/api/inbox/send", body),
  // Owner surface only: mark read / snooze (a snooze is "later", never delete).
  inboxRead: (id: number) => req<{ ok?: boolean }>("POST", "/api/inbox/read", { id }),
  usageSend: (events: UsageEvent[]) =>
    req<{ ok?: boolean }>("POST", "/api/usage", { client: "ios", events }),
  inboxSnooze: (id: number, hours: number) =>
    req<{ ok?: boolean; snoozed_until?: number }>("POST", "/api/inbox/snooze", { id, hours }),
  /** Decide an org (Red) approval; approving runs the queued action. Throws
   *  with `status`: 403 when you raised it, 404 when it is gone or decided. */
  orgResolveApproval: (body: { id: number; resolution: "approved" | "denied" }) =>
    req<Approval & { result?: { error?: string } }>("POST", "/api/org/approvals/resolve", body),
  orgAudit: async (result: AuditFilter = "all", before?: number) =>
    parseAuditPage(await req("GET", auditPath(result, before)), before),
  orgHarman: () => req<HarmanConfig>("GET", "/api/org/harman"),
  orgSetHarman: (patch: Partial<HarmanConfig>) =>
    req<HarmanConfig | Queued>("POST", "/api/org/harman", patch),
  // Loop-firing mode. Manager-scoped and green (setting it never queues), so the
  // response is always the applied config — no Queued union, unlike the Red resume.
  orgLoopControl: () => req<LoopControl>("GET", "/api/org/loop-control"),
  orgSetLoopControl: (mode: LoopMode) =>
    req<LoopControl>("POST", "/api/org/loop-control", { mode }),
  // The global system-awareness preamble prepended to every session's system
  // prompt. Read is open; the write is manager-scoped AND Red — a non-owner
  // caller gets an approval back, not the value, hence the `| Queued` union.
  orgSystemPreamble: () => req<{ preamble: string }>("GET", "/api/org/system-preamble"),
  orgSetSystemPreamble: (preamble: string) =>
    req<{ preamble: string } | Queued>("POST", "/api/org/system-preamble", { preamble }),
  orgSkills: () => req<{ skills: LearnedSkill[] }>("GET", "/api/org/skills"),
}
