/**
 * Typed client for the Agents server HTTP + WebSocket API.
 *
 * Mirrors web/src/lib/api.ts, but authenticates with a Bearer token (mobile has
 * no cookie jar) instead of the HttpOnly `viewer_session` cookie. The backend
 * accepts either — see viewer/server.py `_auth_token`.
 */
import { serverUrl, token } from "../state/config"
import { normModel } from "../lib/model"
import type { AIConfig, AISelection, ConnectionDraft, KeyAction, ModelDiscovery } from "../lib/aiSelection"
import { auditPath, parseAuditPage, type AuditFilter } from "../lib/audit"

export type User = { id: number; username: string }
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
export type SessionMeta = { goal?: string; systemPrompt?: string; avatar?: string; pinned?: string[]; cwd?: string }
export type GitStatus = { repo: boolean; branch?: string; name?: string; remote?: string; root?: string; dirty?: number; ahead?: number | null; behind?: number | null }
// A saved custom LLM provider (OpenAI-compatible endpoint). apiKey is NEVER
// returned by the server — it stays on the box and is revealed only to the runner.
export type Provider = { id: string; name: string; baseUrl: string; model: string; contextLimit?: number; isDefault?: boolean }
// Capabilities: skills + MCP tools (mirrors the web /api/capabilities shape).
export type Skill = { name: string; description?: string; source: string; path: string; editable: boolean }
export type McpServer = { name: string; scope: string; transport: string; target: string; config: Record<string, unknown>; editable: boolean }
export type Capabilities = { skills: Skill[]; mcp: McpServer[] }
/** kind "once" = a one-shot that fires at nextRun and then retires; "recurring"
 *  (the default) follows cron or interval. */
export type Job = { id: string; session: string; prompt: string; interval: number; cron?: string; kind?: "recurring" | "once"; nextRun?: number; runs?: number; enabled?: boolean; provider?: string }
export type AgentTemplate = {
  id: number; name: string; description: string; category: string; icon: string
  system_prompt: string; goal: string; model?: string; cron?: string; job_prompt?: string
  is_builtin: boolean; created_by: string; created_at: number
}
export type PendingQuestion = { tool_use_id: string; questions: unknown }
export type PendingPlan = { tool_use_id: string; plan: string; host?: string }
// ---- org / Kanban (the "empire") ----
export type Employee = { id: number; name: string; role: string; provider: string; model: string; conv_mode: string; avatar: string; status: string; created_at: number }
export type OrgProject = { id: number; name: string; description: string; host: string; cwd: string; created_by: string; created_at: number }
export type BoardColumn = { id: number; name: string; position: number }
/** One row of the cross-session decision queue (GET /api/decisions/open): a
 *  durable question, a durable plan, or a live tool approval. The queue is a
 *  READ of the existing sources — deciding an item uses the per-session
 *  routes, never this shape. */
export type OpenDecision = {
  kind: "question" | "plan" | "approval" | "card"
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
  /** kind "card": the board card parked in Review/Needs-info for the owner. */
  card?: number
  column?: string
  /** The item's inbox row (0 when none was delivered) — the handle a snooze
   *  takes. The queue already omits items whose snooze is live. */
  inbox_id: number
  snoozed_until: number
}
export type Card = { id: number; title: string; body: string; column_id: number | null; assignee: number | null; project_id: number | null; session_id: string | null; position: number; created_by: string; created_at: number; updated_at: number; comment_count?: number }
export type CardComment = { id: number; card_id: number; author: string; body: string; created_at: number }
export type Approval = { id: number; kind: string; summary: string; detail: unknown; status: string; created_by: string; created_at: number; resolved_at?: number; resolution?: string }
export type CardFilter = { session?: string; project?: number; assignee?: number }
// A note: the org's knowledge ledger next to the board (server: viewer/db notes).
// `kind` is its template; `archived` follows the owning chat's archive flag.
export type NoteKind = "note" | "journal" | "meeting" | "idea" | "checklist"
export type Note = { id: number; title: string; body: string; kind: NoteKind; project_id: number | null; session_id: string | null; pinned: boolean; archived: boolean; created_by: string; created_at: number; updated_at: number }
export type NoteFilter = { session?: string; project?: number; archived?: boolean }
// ---- inbox (the channel: you ↔ owner ↔ peer sessions) ----
// A row of the message ledger. `kind` is "message" for a free message, or a
// decision kind (question | plan | approval | card) that was auto-delivered
// from its durable source — the inbox is a delivery SURFACE, never a second
// decision system. `open` is derived at read time from the live sources; a
// lapsed snooze re-reads as unread, so a skipped decision resurfaces.
export type InboxKind = "message" | "question" | "plan" | "approval" | "card"
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
export type HarmanConfig = { automation_enabled?: boolean; enabled: boolean; interval: number; budget: number; projects: number[]; default_provider: string }
/** WHICH loop origins may fire, orthogonal to the automation master switch:
 *  user = the owner's own scheduled loops only (the default), harman = agent-created
 *  loops only, both = every loop, none = paused. Governs loop firing alone; it does
 *  NOT start Harman's manager tick (that is `automation_enabled`). */
export type LoopMode = "user" | "harman" | "both" | "none"
export type LoopControl = { mode: LoopMode }
/** One row of the team skill library (/api/org/skills): every SKILL.md on disk joined with
 *  the learned-skill ledger. Ledger fields are absent for a hand-written/installed skill;
 *  status "missing" means a ledger row whose file is gone. */
export type LearnedSkill = { id?: number; name: string; path: string; description?: string; origin_employee?: number | null; origin_card?: number | null; origin_session?: string | null; status: string; created_at?: number }
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
  size?: number
  /** Emoji avatar chosen on the Session profile page (overlaid server-side). */
  avatar?: string
  /** Server-side flags (session meta): archived hides from the main list; favorite pins. */
  archived?: boolean
  favorite?: boolean
  /** Last visible message, "You: …"-prefixed for user turns (chat-list preview). */
  preview?: string
  /** Server-authoritative unread bit for THIS reader (principal), not per-device:
   *  true when the transcript changed since this reader last opened it. */
  unread?: boolean
  /** Live run flag: a run is in flight for this session. Per-viewer-process truth
   *  (the jobs THIS viewer started), not a cross-host guarantee. */
  running?: boolean
  /** The employee driving this session (org↔fleet join, attached server-side when
   *  the session's token carries an employee_id); absent when unlinked. */
  persona?: SessionPersona
}

/** The employee driving a session — org↔fleet join from _overlay_meta.
 *  DUPLICATED in web/src/lib/types.ts; the two apps share no build. */
export type SessionPersona = { id: number; name: string; role: string; avatar: string }

function authHeaders(): Record<string, string> {
  const t = token()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

async function req<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  if (!serverUrl()) throw new Error("No server configured")
  const res = await fetch(serverUrl() + path, {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
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

export const api = {
  // ---- auth ----
  authState: () => req<{ signupOpen: boolean; user: User | null }>("GET", "/api/auth/state"),
  me: () => req<{ user: User | null }>("GET", "/api/auth/me"),
  signin: (username: string, password: string) =>
    req<{ user: User; token?: string }>("POST", "/api/auth/signin", { username, password, wantToken: true }),
  signup: (username: string, password: string) =>
    req<{ user: User; token?: string }>("POST", "/api/auth/signup", { username, password, wantToken: true }),
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
  sessionRead: async (host: string, path: string, tail = 400): Promise<string[]> => {
    if (!serverUrl()) throw new Error("No server configured")
    const q = new URLSearchParams({ tail: String(tail) })
    if (host && host !== "local") q.set("host", host)
    const res = await fetch(`${serverUrl()}/api/session/${path}?${q.toString()}`, { headers: authHeaders() })
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`) as Error & { status?: number }
      err.status = res.status
      throw err
    }
    const env = (await res.json()) as { lines?: string[] }
    return Array.isArray(env.lines) ? env.lines : []
  },
  // Like sessionRead but returns the paging envelope too: `start` is the byte
  // offset of the first returned line (0 ⇒ we've reached the top of the file, so
  // there's no older history to load). Used by the thread to grow its window when
  // the user scrolls up.
  sessionReadPage: async (
    host: string,
    path: string,
    tail = 400
  ): Promise<{ lines: string[]; start: number; size: number }> => {
    if (!serverUrl()) throw new Error("No server configured")
    const q = new URLSearchParams({ tail: String(tail) })
    if (host && host !== "local") q.set("host", host)
    const res = await fetch(`${serverUrl()}/api/session/${path}?${q.toString()}`, { headers: authHeaders() })
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`) as Error & { status?: number }
      err.status = res.status
      throw err
    }
    const env = (await res.json()) as { lines?: string[]; start?: number; size?: number }
    return { lines: Array.isArray(env.lines) ? env.lines : [], start: env.start ?? 0, size: env.size ?? 0 }
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
  }) => req<{ started: boolean; session: string; path: string }>("POST", "/api/new-session", { ...body, model: normModel(body.model) }),
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

  sessionDetail: (host: string, id: string) =>
    req<{ session: string; meta: { permission_mode: string }; running: boolean }>(
      "GET", `/api/session-detail?${new URLSearchParams({ host, id, agent: "claude" })}`
    ),
  sessionModeSet: (session: string, mode: PermissionMode) =>
    req<{ session?: string; permission_mode?: PermissionMode; error?: string; queued?: boolean; denied?: boolean; reason?: string }>(
      "POST", "/api/session/mode", { for_session: session, mode }
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
  providerSave: (body: { id?: string; name: string; baseUrl: string; model: string; apiKey?: string; apiKeyAction?: KeyAction; contextLimit?: number }) =>
    req<Provider & { error?: string }>("POST", "/api/providers", body),
  providerDelete: (id: string) => req<{ deleted?: boolean }>("POST", "/api/providers/delete", { id }),
  providerDefault: () => req<{ id: string }>("GET", "/api/providers/default"),
  providerModels: (q: { id: string }) =>
    req<ModelDiscovery>("GET", `/api/providers/models?${new URLSearchParams(q)}`),
  providerDraftModels: (draft: ConnectionDraft) =>
    req<ModelDiscovery>("POST", "/api/providers/models", draft),

  // ---- capabilities: skills + MCP tools (host-aware), mirrors web api ----
  capabilities: (host: string, cwd?: string) =>
    req<Capabilities>(
      "GET",
      `/api/capabilities?${new URLSearchParams({
        ...(host && host !== "local" ? { host } : {}),
        ...(cwd ? { cwd } : {}),
      }).toString()}`
    ),
  skill: (host: string, path: string) =>
    req<{ content?: string; error?: string }>(
      "GET",
      `/api/skill?path=${encodeURIComponent(path)}` + (host && host !== "local" ? `&host=${encodeURIComponent(host)}` : "")
    ),
  skillSave: (body: { name: string; content: string; scope?: string; cwd?: string; host?: string }) =>
    req<{ saved?: boolean; path?: string; error?: string }>("POST", "/api/skill/save", body),
  skillDelete: (body: { path: string; host?: string }) =>
    req<{ deleted?: boolean; error?: string }>("POST", "/api/skill/delete", body),
  mcpSave: (body: { name: string; scope?: string; config: Record<string, unknown>; cwd?: string; host?: string }) =>
    req<{ saved?: boolean; error?: string }>("POST", "/api/mcp/save", body),
  mcpDelete: (body: { name: string; scope?: string; cwd?: string; host?: string }) =>
    req<{ deleted?: boolean; error?: string }>("POST", "/api/mcp/delete", body),

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
  agentTemplateCreate: (body: Omit<AgentTemplate, "id" | "is_builtin" | "created_by" | "created_at">) =>
    req<{ id?: number }>("POST", "/api/agent-templates", body),
  agentTemplateDelete: (id: number) => req("POST", "/api/agent-templates/delete", { id }),

  // ---- agents available on a host ----
  agents: (host: string) =>
    req<{ agents: AgentInfo[] }>(
      "GET",
      `/api/agents${host && host !== "local" ? `?host=${encodeURIComponent(host)}` : ""}`
    ),

  // ---- filesystem browser (host-aware) ----
  fs: (host: string, path: string, hidden = false) =>
    req<FileList>(
      "GET",
      `/api/fs?path=${encodeURIComponent(path)}&hidden=${hidden ? 1 : 0}` +
        (host && host !== "local" ? `&host=${encodeURIComponent(host)}` : "")
    ),

  // Create a folder. `name` must be a single segment (server rejects slashes).
  fsMkdir: (body: { path: string; name: string; host?: string }) =>
    req<{ error?: string }>("POST", "/api/fs/mkdir", body),

  // Delete a file/folder (server moves it to a reversible trash dir).
  fsDelete: (body: { path: string; host?: string }) =>
    req<{ deleted?: string; error?: string }>("POST", "/api/fs/delete", body),

  // Rename a single entry in place. `name` is one path segment.
  fsRename: (body: { path: string; name: string; host?: string }) =>
    req<{ renamed?: string; error?: string }>("POST", "/api/fs/rename", body),

  // Upload a file to `dir` on `host` via multipart/form-data. RN's FormData
  // takes a { uri, name, type } object for a file part; the server parses the
  // multipart body into (filename, bytes) — see _p_fs_upload.
  fsUpload: async (host: string, dir: string, uri: string, name: string, mime?: string) => {
    if (!serverUrl()) throw new Error("No server configured")
    const form = new FormData()
    // @ts-expect-error RN FormData accepts the {uri,name,type} file shape.
    form.append("file", { uri, name, type: mime || "application/octet-stream" })
    const q = new URLSearchParams({ path: dir })
    if (host && host !== "local") q.set("host", host)
    const res = await fetch(`${serverUrl()}/api/fs/upload?${q.toString()}`, {
      method: "POST",
      // NOTE: do NOT set Content-Type — fetch adds the multipart boundary itself.
      headers: authHeaders(),
      body: form,
    })
    const data = (await res.json().catch(() => null)) as { uploaded?: unknown[]; error?: string } | null
    if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`)
    return data
  },

  // The authed URL for downloading a file. RN's fetch/FileSystem can pass the
  // Bearer header (a browser <a> can't), so we return the URL + headers for
  // FileSystem.downloadAsync to save it to disk, then share it.
  fsDownloadUrl: (host: string, path: string): { url: string; headers: Record<string, string> } => {
    const q = new URLSearchParams({ path })
    if (host && host !== "local") q.set("host", host)
    return { url: `${serverUrl()}/api/fs/download?${q.toString()}`, headers: authHeaders() }
  },

  // ---- voice (call listening + text-to-speech) ----
  // Streaming TTS URL for react-native-track-player: a GET that returns a live
  // AAC stream (Pocket generate_audio_stream -> ffmpeg). track-player plays the
  // URL and can send the Authorization header, so first audio arrives in ~0.5s
  // even for a long reply. Returns { url, headers } for TrackPlayer.add().
  voiceTtsStreamUrl: (text: string): { url: string; headers: Record<string, string> } => ({
    url: `${serverUrl()}/api/voice/tts/stream?text=${encodeURIComponent(text)}`,
    headers: authHeaders(),
  }),
  // Call listening WebSocket. The app streams endpointed utterances (binary
  // frames); the server transcribes each on the GPU box and pushes back
  // {type:"utterance",text}. mode=call: the call itself is the "talking to you"
  // signal, so there is no per-turn wake word. Auth rides the handshake header.
  voiceWsUrl: (): { url: string; headers: Record<string, string> } => ({
    url: `${serverUrl().replace(/^http/, "ws")}/api/voice/ws?mode=call`,
    headers: authHeaders(),
  }),

  // ---- Nemotron voicechat (call audio, turn-based) ----
  // GET /api/voice/nemotron/status -> the GPU service's /health passed through
  // (see viewer.nemotron.status). Always 200 in the normal/disabled case; only a
  // configured-but-broken backend returns 502 with `error` set. `ready:false`
  // while idle is EXPECTED (the model loads per call). Consulted only AFTER
  // callEngine chose "nemotron" — it never decides the engine.
  nemotronStatus: () => req<NemotronStatus>("GET", "/api/voice/nemotron/status"),
  // The one Nemotron call WS for a session. Same auth pattern as voiceWsUrl:
  // Bearer token on the handshake header (RN's WebSocket 3rd-arg), never a
  // query param. `kind:"ready"` arrives once the model loaded for this call —
  // never send audio before it. Binary replies precede their turn_end frame.
  nemotronWsUrl: (path: string): { url: string; headers: Record<string, string> } => ({
    url: `${serverUrl().replace(/^http/, "ws")}/api/voice/nemotron/ws?path=${encodeURIComponent(path)}`,
    headers: authHeaders(),
  }),

  // Barge-in wake-guard WS: a lightweight keyword-spotting stream that runs WHILE
  // the assistant is speaking. The server uses a cheap KWS pass (not full STT) so
  // it can loop continuously; it fires only when the wake word "Harman" is heard,
  // returning the transcript tail for command parsing (stop / end / new question).
  voiceWakeguardWsUrl: (speakerId = "default"): { url: string; headers: Record<string, string> } => {
    const base = serverUrl().replace(/^http/, "ws")
    return {
      url: `${base}/api/voice/ws?speaker_id=${encodeURIComponent(speakerId)}&mode=wakeguard`,
      headers: authHeaders(),
    }
  },

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

  // ---- terminal WS ----
  // Mirrors web/ TerminalPanel: binary output, JSON `{t:"i",d}` input,
  // `{t:"r",cols,rows}` resize. Auth: RN's WebSocket can send an Authorization
  // header (unlike a browser), so the token rides the handshake — see
  // TerminalScreen. `local` host is implied by omitting the param.
  terminalWsUrl: (opts: { cols: number; rows: number; host?: string; key?: string; init?: string }) => {
    const base = serverUrl().replace(/^http/, "ws")
    const p = new URLSearchParams({ cols: String(opts.cols), rows: String(opts.rows) })
    if (opts.host && opts.host !== "local") p.set("host", opts.host)
    if (opts.key) p.set("key", opts.key)
    if (opts.init) p.set("init", opts.init)
    return `${base}/api/terminal/ws?${p.toString()}`
  },

  // ---- org / Kanban (the "empire") ----
  orgEmployees: () => req<{ employees: Employee[] }>("GET", "/api/org/employees"),
  orgCreateEmployee: (body: { name: string; role?: string; provider?: string; model?: string }) =>
    req<Employee>("POST", "/api/org/employees", body),
  orgUpdateEmployee: (body: { id: number; name?: string; role?: string; provider?: string; model?: string; conv_mode?: string; avatar?: string; status?: string }) =>
    req<Employee>("POST", "/api/org/employees/update", body),
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
  orgCards: (filter: CardFilter = {}) => {
    const p = new URLSearchParams()
    if (filter.session !== undefined) p.set("session", filter.session)
    if (filter.project !== undefined) p.set("project", String(filter.project))
    if (filter.assignee !== undefined) p.set("assignee", String(filter.assignee))
    const q = p.toString()
    return req<{ cards: Card[] }>("GET", `/api/org/cards${q ? "?" + q : ""}`)
  },
  orgCreateCard: (body: { title: string; body?: string; column_id?: number; project_id?: number; session?: string; position?: number }) =>
    req<Card>("POST", "/api/org/cards", body),
  orgMoveCard: (body: { card_id: number; column_id: number; position: number }) =>
    req<Card>("POST", "/api/org/cards/move", body),
  orgAssignCard: (body: { card_id: number; assignee: number }) =>
    req<Card>("POST", "/api/org/cards/assign", body),
  orgUpdateCard: (body: { card_id: number; title?: string; body?: string; column_id?: number; assignee?: number; project_id?: number; position?: number }) =>
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
    req<Note>("POST", "/api/org/notes/update", body),
  // `note_delete` is Red: an agent's delete queues; the owner's runs.
  orgDeleteNote: (body: { note_id: number }) =>
    req<{ deleted?: boolean } | Queued>("POST", "/api/org/notes/delete", body),
  orgApprovals: () => req<{ approvals: Approval[] }>("GET", "/api/org/approvals"),
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
  inboxSend: (body: { to: string; body: string; in_reply_to?: number }) =>
    req<InboxMessage>("POST", "/api/inbox/send", body),
  // Owner surface only: mark read / snooze (a snooze is "later", never delete).
  inboxRead: (id: number) => req<{ ok?: boolean }>("POST", "/api/inbox/read", { id }),
  inboxSnooze: (id: number, hours: number) =>
    req<{ ok?: boolean; snoozed_until?: number }>("POST", "/api/inbox/snooze", { id, hours }),
  orgResolveApproval: (body: { id: number; resolution: string }) =>
    req<Approval>("POST", "/api/org/approvals/resolve", body),
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
