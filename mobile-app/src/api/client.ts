/**
 * Typed client for the Agents server HTTP + WebSocket API.
 *
 * Mirrors web/src/lib/api.ts, but authenticates with a Bearer token (mobile has
 * no cookie jar) instead of the HttpOnly `viewer_session` cookie. The backend
 * accepts either — see viewer/server.py `_auth_token`.
 */
import { serverUrl, token } from "../state/config"
import { normModel } from "../lib/model"

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
export type PermApproval = { id: string; tool_name: string; input: unknown }
export type SessionMeta = { goal?: string; systemPrompt?: string; avatar?: string; pinned?: string[]; cwd?: string; provider?: string; convMode?: "chat" | "agent" }
export type GitStatus = { repo: boolean; branch?: string; name?: string; remote?: string; root?: string; dirty?: number; ahead?: number | null; behind?: number | null }
// A saved custom LLM provider (OpenAI-compatible endpoint). apiKey is NEVER
// returned by the server — it stays on the box and is revealed only to the runner.
export type Provider = { id: string; name: string; baseUrl: string; model: string; contextLimit?: number }
// Capabilities: skills + MCP tools (mirrors the web /api/capabilities shape).
export type Skill = { name: string; description?: string; source: string; path: string; editable: boolean }
export type McpServer = { name: string; scope: string; transport: string; target: string; config: Record<string, unknown>; editable: boolean }
export type Capabilities = { skills: Skill[]; mcp: McpServer[] }
export type Loop = { id: string; session: string; prompt: string; interval: number; nextRun?: number; runs?: number; enabled?: boolean }
export type PendingQuestion = { tool_use_id: string; questions: unknown }
export type PendingPlan = { tool_use_id: string; plan: string; host?: string }
// ---- org / Kanban (the "empire") ----
export type Employee = { id: number; name: string; role: string; provider: string; model: string; conv_mode: string; avatar: string; status: string; created_at: number }
export type OrgProject = { id: number; name: string; description: string; host: string; cwd: string; created_by: string; created_at: number }
export type BoardColumn = { id: number; name: string; position: number }
export type Card = { id: number; title: string; body: string; column_id: number | null; assignee: number | null; project_id: number | null; session_id: string | null; position: number; created_by: string; created_at: number; updated_at: number }
export type Approval = { id: number; kind: string; summary: string; detail: unknown; status: string; created_by: string; created_at: number; resolved_at?: number; resolution?: string }
export type AuditEntry = { id: number; actor: string; action: string; target: unknown; outcome: string; created_at: number }
export type CardFilter = { session?: string; project?: number; assignee?: number }
export type HarmanConfig = { enabled: boolean; interval: number; budget: number; projects: number[]; default_provider: string }
export type LearnedSkill = { id: number; name: string; path: string; origin_employee: number | null; origin_card: number | null; origin_session: string | null; status: string; created_at: number }
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
}

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
    const msg = (data as { error?: string })?.error || `HTTP ${res.status}`
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
  pushRegister: (token: string, platform = "ios") =>
    req<{ registered?: boolean; error?: string }>("POST", "/api/push/register", { token, platform }),
  pushUnregister: (token: string) =>
    req<{ unregistered?: boolean }>("POST", "/api/push/unregister", { token }),

  // ---- hosts ----
  hosts: () => req<Host[]>("GET", "/api/hosts"),

  // ---- sessions ----
  sessions: (host: string) =>
    req<Session[]>("GET", `/api/sessions?host=${encodeURIComponent(host)}`),
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
  }) => req<{ started: boolean; session: string; path: string }>("POST", "/api/new-session", { ...body, model: normModel(body.model) }),
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
  // the questions. Returns {resumed:true} once the resumed run starts.
  chatQuestionAnswer: (body: { session: string; picks: string[]; mode?: string; model?: string }) =>
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

  // ---- per-session metadata (system prompt + goal), mirrors web api.sessionMeta ----
  sessionMeta: (host: string, session: string) =>
    req<SessionMeta>(
      "GET",
      `/api/session-meta?session=${encodeURIComponent(session)}` +
        (host && host !== "local" ? `&host=${encodeURIComponent(host)}` : "")
    ),
  sessionMetaSave: (body: { session: string; goal?: string; systemPrompt?: string; avatar?: string; archived?: boolean; favorite?: boolean; pinned?: string[]; provider?: string; convMode?: "chat" | "agent"; host?: string }) =>
    req<{ ok?: boolean }>("POST", "/api/session-meta", body),

  // ---- custom LLM providers (OpenAI-compatible endpoints). The apiKey is sent
  //      on save but never returned; /models is fetched server-side so the key
  //      never touches the device. ----
  providers: () => req<{ providers: Provider[] }>("GET", "/api/providers"),
  providerSave: (body: { id?: string; name: string; baseUrl: string; model: string; apiKey?: string; contextLimit?: number }) =>
    req<Provider & { error?: string }>("POST", "/api/providers", body),
  providerDelete: (id: string) => req<{ deleted?: boolean }>("POST", "/api/providers/delete", { id }),
  // Populate the model dropdown: either from a saved preset (id), or by probing a
  // baseUrl+key before the preset is saved.
  providerModels: (q: { id: string } | { baseUrl: string; key?: string }) =>
    req<{ models: string[]; error?: string }>(
      "GET",
      "/api/providers/models?" +
        new URLSearchParams(
          "id" in q ? { id: q.id } : { baseUrl: q.baseUrl, ...(q.key ? { key: q.key } : {}) }
        ).toString()
    ),

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

  // ---- scheduled loops (re-run a prompt on an interval), mirrors web api.loops ----
  loops: (sessionId: string) => req<Loop[]>("GET", `/api/loops?session=${encodeURIComponent(sessionId)}`),
  loopsCreate: (body: { session: string; prompt: string; interval: number; model?: string }) =>
    req<{ id?: string }>("POST", "/api/loops", body),
  loopsDelete: (id: string) => req("POST", "/api/loops/delete", { id }),

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

  // ---- voice (speech-to-text + text-to-speech) ----
  // STT: POST the recorded audio as the raw request body (the server reads the
  // body directly by Content-Length — see _p_voice_stt). `body` is a Blob (RN
  // gives one from fetch(fileUri).blob()) so the platform sets Content-Length.
  voiceStt: async (audio: Blob, mime = "audio/m4a"): Promise<{ text: string }> => {
    if (!serverUrl()) throw new Error("No server configured")
    const res = await fetch(`${serverUrl()}/api/voice/stt`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": mime },
      body: audio,
    })
    const data = (await res.json().catch(() => null)) as { text?: string; error?: string } | null
    if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`)
    return { text: data?.text || "" }
  },
  // TTS: POST text, get back WAV audio bytes as a Blob. The voice lib writes it
  // to a temp file for Audio playback (expo-av can't POST a remote source).
  voiceTts: async (text: string): Promise<Blob> => {
    if (!serverUrl()) throw new Error("No server configured")
    const res = await fetch(`${serverUrl()}/api/voice/tts`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(err?.error || `HTTP ${res.status}`)
    }
    return await res.blob()
  },
  // Streaming TTS URL for react-native-track-player: a GET that returns a live
  // AAC stream (Pocket generate_audio_stream -> ffmpeg). track-player plays the
  // URL and can send the Authorization header, so first audio arrives in ~0.5s
  // even for a long reply. Returns { url, headers } for TrackPlayer.add().
  // assistant=true routes to the Harman assistant service: `text` is the user's
  // UTTERANCE (not a pre-made reply); the server answers via the Qwen agent and
  // speaks it back in the cloned assistant voice — brain + voice in one stream.
  voiceTtsStreamUrl: (text: string, assistant?: boolean): { url: string; headers: Record<string, string> } => ({
    url: `${serverUrl()}/api/voice/tts/stream?text=${encodeURIComponent(text)}${assistant ? "&assistant=1" : ""}`,
    headers: authHeaders(),
  }),
  // Enroll the user's voiceprint from a recorded clip (a few seconds of speech).
  // Body is the raw audio Blob (same wire shape as voiceStt); the server stores a
  // speaker embedding so hands-free listening can verify the speaker.
  voiceEnroll: async (
    audio: Blob,
    speakerId = "default",
    mime = "audio/m4a"
  ): Promise<{ ok: boolean; speaker_id?: string; dim?: number }> => {
    if (!serverUrl()) throw new Error("No server configured")
    const res = await fetch(
      `${serverUrl()}/api/voice/enroll?speaker_id=${encodeURIComponent(speakerId)}`,
      { method: "POST", headers: { ...authHeaders(), "Content-Type": mime }, body: audio }
    )
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; speaker_id?: string; dim?: number; error?: string }
      | null
    if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`)
    return { ok: !!data?.ok, speaker_id: data?.speaker_id, dim: data?.dim }
  },
  // Hands-free listening WebSocket. The app streams short audio windows (binary
  // frames); the server runs wake-word + strict speaker verification on the GPU
  // box and pushes back {type:"utterance",text} ONLY when the enrolled user says
  // "Harman …". Auth rides the handshake header (RN WebSocket allows it).
  voiceWsUrl: (speakerId = "default", callMode = false): { url: string; headers: Record<string, string> } => {
    const base = serverUrl().replace(/^http/, "ws")
    // callMode drops the per-turn "Harman" wake word (a phone call is already the
    // "talking to you" signal); speaker verification still gates who.
    const mode = callMode ? "&mode=call" : ""
    return {
      url: `${base}/api/voice/ws?speaker_id=${encodeURIComponent(speakerId)}${mode}`,
      headers: authHeaders(),
    }
  },

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
  orgBoard: () => req<{ columns: BoardColumn[] }>("GET", "/api/org/board"),
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
  orgUpdateCard: (body: { card_id: number; title?: string; body?: string; column_id?: number; assignee?: number; position?: number }) =>
    req<Card>("POST", "/api/org/cards/update", body),
  orgDeleteCard: (body: { card_id: number }) =>
    req<{ deleted?: boolean }>("POST", "/api/org/cards/delete", body),
  orgApprovals: () => req<{ approvals: Approval[] }>("GET", "/api/org/approvals"),
  orgResolveApproval: (body: { id: number; resolution: string }) =>
    req<Approval>("POST", "/api/org/approvals/resolve", body),
  orgAudit: (limit = 100) => req<{ audit: AuditEntry[] }>("GET", `/api/org/audit?limit=${limit}`),
  orgHarman: () => req<HarmanConfig>("GET", "/api/org/harman"),
  orgSetHarman: (patch: Partial<HarmanConfig>) => req<HarmanConfig>("POST", "/api/org/harman", patch),
  orgSkills: () => req<{ skills: LearnedSkill[] }>("GET", "/api/org/skills"),
}
