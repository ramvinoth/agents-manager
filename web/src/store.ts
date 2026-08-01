import { create } from "zustand"
import { api } from "./lib/api"
import { describeHost } from "./lib/host"
import { SessionParser } from "./lib/parser"
import type {
  AgentInfo,
  Capabilities,
  GitStatus,
  HostInfo,
  Loop,
  SessionAnalysis,
  SessionListItem,
  SessionMeta,
  SessionSummary,
  SlashCommand,
  Turn,
  VisibleTypes,
} from "./lib/types"

const TAIL_LINES = 400
const CHUNK_LINES = 400
const POLL_MS = 2000

/** Restore scope — mirrors Claude Code's /rewind menu. */
export type RestoreMode = "conversation" | "code" | "code+conversation"

export interface AuthStatus {
  loggedIn?: boolean
  method?: string
  subscriptionType?: string
}
export interface ChatStatus {
  kind: "running" | "done" | "error"
  text: string
}
export interface PermApproval {
  id: string
  tool_name: string
  input: unknown
}

// Non-reactive timers (module-level so they never trigger re-renders).
let pollTimer: ReturnType<typeof setInterval> | null = null
let chatTimer: ReturnType<typeof setInterval> | null = null
let nsTimer: ReturnType<typeof setInterval> | null = null
let loginTimer: ReturnType<typeof setInterval> | null = null
let agentLoginTimer: ReturnType<typeof setInterval> | null = null
let polling = false
// Per-session baseline for auto-analysis: the 10-user-message bucket last seen.
// null means "not yet observed" so we never fire on load, only on new crossings.
let analyzeBucket: number | null = null
// Slow git-status refresh: every N poll ticks (catches branch switches made in
// a terminal), on top of the immediate refreshes on session load / run end.
let gitTick = 0

export interface ProjectDir {
  cwd: string
  [k: string]: unknown
}
export interface NewSessionOpts {
  cwd: string
  message: string
  title?: string
  systemPrompt?: string
  goal?: string
}

interface AppState {
  agents: AgentInfo[]
  currentAgent: string
  currentHost: string
  hosts: HostInfo[]
  sessions: SessionListItem[]
  currentSessionPath: string
  turns: Turn[]
  parser: SessionParser
  fileSize: number
  headOffset: number
  tailOffset: number
  auth: AuthStatus | null
  loading: boolean
  loadingOlder: boolean
  error: string | null
  lhsTab: string
  rhsTab: string
  chatRunning: boolean
  chatStatus: ChatStatus | null
  queue: string[]
  pendingApprovals: PermApproval[]
  stash: string[]
  permMode: string
  model: string
  panel: "terminal" | "browser" | null
  // When set, the terminal panel launches this command in a dedicated persistent
  // session (key) instead of the general host shell — used by "Continue interactively".
  termInit: { key: string; cmd: string } | null
  fsOpen: boolean
  fsPick: ((dir: string) => void) | null
  dockSplit: number
  panelFloating: boolean
  floatRect: { x: number; y: number; w: number; h: number }
  caps: Capabilities
  capsLoading: boolean
  projects: ProjectDir[]
  slashCommands: SlashCommand[]
  fullSummary: SessionSummary | null
  analysis: SessionAnalysis | null
  analysisLoading: boolean
  analysisError: string | null
  meta: SessionMeta | null
  git: GitStatus | null
  loops: Loop[]
  visible: VisibleTypes
  searchOpen: boolean
  searchQuery: string
  searchMatches: string[]
  searchIndex: number
  loginActive: boolean
  loginUrl: string
  loginNote: string
  needsAuth: boolean
  authUser: { id: number; username: string } | null
  signupOpen: boolean
  signin: (username: string, password: string) => Promise<string | undefined>
  signup: (username: string, password: string) => Promise<string | undefined>
  signout: () => Promise<void>

  refreshAuth: () => Promise<void>
  startLogin: () => Promise<void>
  submitLoginCode: (code: string) => Promise<void>
  cancelLogin: () => void
  openSearch: () => void
  closeSearch: () => void
  setSearchQuery: (q: string) => void
  searchNav: (dir: number) => void

  init: () => Promise<void>
  loadAgents: () => Promise<void>
  setAgent: (id: string) => Promise<void>
  installing: string | null
  installAgent: (id: string) => Promise<void>
  agentLogin: { agent: string; stage: string; url: string | null; error: string; note?: string; code?: string | null } | null
  startAgentLogin: (id: string) => Promise<void>
  submitAgentLogin: (callback: string) => Promise<void>
  cancelAgentLogin: () => void
  loadOlder: () => Promise<void>
  loadCapabilities: () => Promise<void>
  loadCommands: () => Promise<void>
  loadSummary: () => Promise<void>
  analyzeSession: (refresh?: boolean) => Promise<void>
  maybeAutoAnalyze: () => void
  loadMeta: () => Promise<void>
  saveMeta: (field: "goal" | "systemPrompt", value: string) => Promise<void>
  loadGitStatus: () => Promise<void>
  loadLoops: () => Promise<void>
  createLoop: (prompt: string, interval: number, model: string) => Promise<void>
  deleteLoop: (id: string) => Promise<void>
  toggleVisible: (t: keyof VisibleTypes) => void
  loadProjects: () => Promise<void>
  startNewSession: (opts: NewSessionOpts) => Promise<void>
  renameCurrent: (title: string) => Promise<void>
  deleteByPath: (path: string) => Promise<void>
  setHost: (hid: string) => Promise<void>
  refreshHosts: () => Promise<void>
  loadSession: (path: string) => Promise<void>
  droppedFile: string | null
  loadDroppedFile: (file: File) => Promise<void>
  setLhsTab: (t: string) => void
  setRhsTab: (t: string) => void
  setPermMode: (m: string) => void
  setModel: (m: string) => void
  sendChat: (msg: string) => Promise<string | undefined>
  forkFromMessage: (uuid: string) => Promise<void>
  revertToMessage: (uuid: string, mode?: RestoreMode) => Promise<void>
  pendingDraft: string | null
  clearPendingDraft: () => void
  steerMessage: (msg: string) => Promise<string | undefined>
  interruptRun: () => Promise<void>
  decidePermission: (id: string, decision: "allow" | "deny") => Promise<void>
  removeQueued: (i: number) => Promise<void>
  addStash: (text: string) => void
  removeStash: (i: number) => void
  openPanel: (k: "terminal" | "browser") => void
  closePanel: () => void
  continueInteractively: (cmd: string, key: string) => void
  openFs: () => void
  pickDir: (cb: (dir: string) => void) => void
  closeFs: () => void
  setDockSplit: (n: number) => void
  toggleFloating: () => void
  setFloatRect: (r: { x: number; y: number; w: number; h: number }) => void
}

function sessionIdOf(path: string): string {
  return path ? path.split("/").pop()!.replace(".jsonl", "") : ""
}

function turnText(t: Turn): string {
  if (t.type === "assistant")
    return t.blocks.map((b) => (b.type === "text" ? b.text : b.name)).join(" ")
  return t.content
}

function pickOpen(sessions: SessionListItem[], host: string): string | undefined {
  const last = localStorage.getItem("lastSession:" + host)
  return last && sessions.some((s) => s.path === last) ? last : sessions[0]?.path
}

async function reloadForHost(): Promise<{ hosts: HostInfo[]; sessions: SessionListItem[] }> {
  const hosts = (await api.hosts()) as HostInfo[]
  const sessions = (await api.sessions()) as SessionListItem[]
  if (!Array.isArray(sessions)) throw new Error((sessions as any).error || "host error")
  return { hosts, sessions }
}

/** The label of the currently-selected agent, for generic UI copy. */
export const useAgentLabel = () =>
  useStore((s) => s.agents.find((a) => a.id === s.currentAgent)?.label || "Agent")

export const useStore = create<AppState>((set, get) => {
  function stopTimers() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    if (chatTimer) { clearInterval(chatTimer); chatTimer = null }
    if (nsTimer) { clearInterval(nsTimer); nsTimer = null }
  }

  // Load everything once we're authenticated (called from init and after login).
  async function bootApp() {
    const host = get().currentHost
    api.setHost(host)
    api.setAgent(get().currentAgent)
    api.authStatus().then((a) => set({ auth: a })).catch(() => {})
    get().loadAgents()
    api.getPrefs().then((p: any) => {
      if (p && p.theme) {
        localStorage.setItem("theme", p.theme)
        document.documentElement.classList.toggle("dark", p.theme === "dark")
      }
    }).catch(() => {})
    set({ loading: true })
    try {
      const { hosts, sessions } = await reloadForHost()
      set({ hosts, sessions, loading: false })
      const open = pickOpen(sessions, host)
      if (open) await get().loadSession(open)
      else set({ loading: false })
    } catch (e: any) {
      set({ loading: false, error: String(e?.message || e) })
    }
  }

  function watchNewSession(sid: string, title?: string, immediatePath?: string) {
    const open = async (path: string) => {
      if (title) await api.renameSession({ session: path, title }).catch(() => {})
      await get().loadSession(path)
      api.sessions().then((s: any) => Array.isArray(s) && set({ sessions: s })).catch(() => {})
      set({ chatRunning: true, chatStatus: null })
      watchChat(sessionIdOf(path))
    }
    // Codex returns the rollout path up front (the session already exists), so
    // open it directly instead of polling /api/resolve (a Claude-only lookup).
    if (immediatePath) { open(immediatePath); return }
    if (nsTimer) clearInterval(nsTimer)
    nsTimer = setInterval(async () => {
      try {
        const d: any = await api.resolve(sid)
        if (d.found) {
          if (nsTimer) { clearInterval(nsTimer); nsTimer = null }
          await open(d.path)
        } else if (!d.running) {
          if (nsTimer) { clearInterval(nsTimer); nsTimer = null }
          set({
            chatRunning: false,
            chatStatus: { kind: "error", text: d.stderr ? "claude: " + d.stderr.slice(-400) : "Session failed to start" },
          })
        }
      } catch {
        /* keep trying */
      }
    }, 1000)
  }

  async function pollTick() {
    const { currentSessionPath, tailOffset, parser, turns } = get()
    if (polling || !currentSessionPath) return
    polling = true
    try {
      const res = await api.sessionReadFrom(currentSessionPath, tailOffset)
      if (res.ok) {
        const d = await res.json()
        // The user may have switched sessions during the fetch — never write a
        // stale read over the newly-selected session.
        if (get().currentSessionPath !== currentSessionPath) return
        if (d.size < tailOffset) {
          await get().loadSession(currentSessionPath)
          return
        }
        if (d.lines.length) {
          const next = [...turns]
          for (const line of d.lines as string[]) {
            const r = parser.ingest(line, false)
            if (r?.turn) next.push(r.turn)
          }
          set({ turns: next, tailOffset: d.end, fileSize: d.size })
        } else {
          set({ tailOffset: d.end, fileSize: d.size })
        }
      }
      // ~30s cadence on the 2s poll: refresh the git bar so branch switches
      // made outside the viewer (terminal, agent) show up without a reload.
      if (++gitTick % 15 === 0 && get().git?.repo) get().loadGitStatus()
    } catch {
      /* transient; retry next tick */
    } finally {
      polling = false
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(pollTick, POLL_MS)
  }

  function watchChat(sessionId: string) {
    if (chatTimer) clearInterval(chatTimer)
    chatTimer = setInterval(async () => {
      try {
        const d: any = await api.chatStatus(sessionId)
        if (d.running) {
          set({ queue: d.queue || [], pendingApprovals: d.pending_approvals || [] })
          return
        }
        if (chatTimer) { clearInterval(chatTimer); chatTimer = null }
        set({ chatRunning: false, queue: [], pendingApprovals: [] })
        await pollTick()
        get().loadGitStatus() // the run may have committed / switched branches
        // Refresh the full-session summary (fresh user-message count) without a
        // null-flash, then re-analyze if we crossed a new 10-message boundary.
        try {
          const sum: any = await api.sessionSummary(get().currentSessionPath)
          if (sum && !sum.error) set({ fullSummary: sum })
        } catch {
          /* keep stale summary */
        }
        get().maybeAutoAnalyze()
        if (d.interrupted) {
          set({ chatStatus: { kind: "done", text: "Interrupted — ready for your next message" } })
        } else if (d.idle || d.returncode === 0) {
          set({ chatStatus: { kind: "done", text: "Done" } })
        } else {
          const label = get().agents.find((a) => a.id === get().currentAgent)?.label || get().currentAgent
          set({
            chatStatus: {
              kind: "error",
              text: `${label} exited with code ${d.returncode}${d.stderr ? ": " + d.stderr.slice(-400) : ""}`,
            },
          })
        }
        setTimeout(() => {
          if (!get().chatRunning) set({ chatStatus: null })
        }, 5000)
      } catch {
        /* keep watching */
      }
    }, 1500)
  }

  function watchLogin() {
    if (loginTimer) clearInterval(loginTimer)
    loginTimer = setInterval(async () => {
      try {
        const d: any = await api.authLoginPoll()
        if (d.stage === "url" && d.url) {
          set({ loginUrl: d.url, loginNote: d.note || "Open the login page, approve access, then paste the code here." })
        }
        if (d.stage === "done") {
          if (loginTimer) { clearInterval(loginTimer); loginTimer = null }
          await get().refreshAuth()
          set({ loginActive: false, loginUrl: "", loginNote: "" })
        }
        if (d.stage === "error") {
          if (loginTimer) { clearInterval(loginTimer); loginTimer = null }
          set({ loginNote: "Login failed: " + (d.error || "try again") })
        }
      } catch {
        /* keep polling */
      }
    }, 1000)
  }

  async function reattach() {
    const sid = sessionIdOf(get().currentSessionPath)
    if (!sid) return
    try {
      const d: any = await api.chatStatus(sid)
      if (d.running) {
        set({ chatRunning: true, queue: d.queue || [], chatStatus: null })
        watchChat(sid)
      }
    } catch {
      /* server unreachable; leave idle */
    }
  }

  // Before driving/creating with a non-Claude agent, make sure it's installed +
  // signed in on the current host — trigger install/login instead of letting the
  // run fail with a cryptic "command not found". Returns true if OK to proceed.
  function agentPreflight(): boolean {
    const { currentAgent, currentHost, agents, hosts } = get()
    if (currentAgent === "claude") return true // Claude auth is the header flow
    const a = agents.find((x) => x.id === currentAgent)
    if (!a) return true // state not loaded yet — let the backend decide
    const hostLabel = describeHost(currentHost, hosts, "this machine")
    if (a.installed === false) {
      set({ chatStatus: { kind: "running", text: `${a.label} isn't installed on ${hostLabel} — installing…` } })
      get().installAgent(currentAgent)
      return false
    }
    if (a.loggedIn === false) {
      if (currentAgent === "codex") {
        // Codex has an in-app OAuth flow, local or remote (over SSH).
        set({ chatStatus: { kind: "error", text: `${a.label} isn't signed in on ${hostLabel} — opening sign-in…` } })
        get().startAgentLogin(currentAgent)
      } else {
        set({
          chatStatus: {
            kind: "error",
            text: `${a.label} isn't signed in on ${hostLabel}. Run \`${a.login || currentAgent}\` in the Terminal panel for this host.`,
          },
        })
      }
      return false
    }
    return true
  }

  // Browsers throttle timers in backgrounded tabs (~1/min), so a transcript
  // update — e.g. a run continuing after you approve a tool — can lag until the
  // tab is focused. Refresh immediately when the tab becomes visible again.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && get().currentSessionPath) pollTick()
    })
  }

  return {
    agents: [],
    currentAgent: localStorage.getItem("currentAgent") || "claude",
    installing: null,
    agentLogin: null,
    currentHost: localStorage.getItem("currentHost") || "local",
    hosts: [],
    droppedFile: null,
    sessions: [],
    currentSessionPath: "",
    turns: [],
    parser: new SessionParser(),
    fileSize: 0,
    headOffset: 0,
    tailOffset: 0,
    auth: null,
    loading: false,
    loadingOlder: false,
    error: null,
    lhsTab: localStorage.getItem("lhsTab") || "settings",
    rhsTab: localStorage.getItem("rhsTab") || "skills",
    chatRunning: false,
    chatStatus: null,
    queue: [],
    pendingApprovals: [],
    stash: JSON.parse(localStorage.getItem("stash") || "[]") as string[],
    permMode: localStorage.getItem("permMode") || "acceptEdits",
    model: localStorage.getItem("model") || "",
    panel: (localStorage.getItem("panel") as "terminal" | "browser" | null) || null,
    termInit: JSON.parse(localStorage.getItem("termInit") || "null"),
    fsOpen: false,
    fsPick: null,
    dockSplit: Math.min(0.85, Math.max(0.15, parseFloat(localStorage.getItem("dockSplit") || "0.5") || 0.5)),
    panelFloating: localStorage.getItem("panelFloating") === "1",
    floatRect: (() => {
      try {
        const r = JSON.parse(localStorage.getItem("floatRect") || "null")
        if (r && typeof r.x === "number") return r
      } catch {
        /* fall through */
      }
      return { x: 140, y: 96, w: 760, h: 480 }
    })(),
    caps: { skills: [], mcp: [] },
    capsLoading: false,
    projects: [],
    slashCommands: [],
    fullSummary: null,
    analysis: null,
    analysisLoading: false,
    analysisError: null,
    pendingDraft: null,
    meta: null,
    git: null,
    loops: [],
    visible: { user: true, assistant: true, system: true, tools: true },
    searchOpen: false,
    searchQuery: "",
    searchMatches: [],
    searchIndex: 0,
    loginActive: false,
    loginUrl: "",
    loginNote: "",
    needsAuth: false,
    authUser: null,
    signupOpen: false,

    init: async () => {
      // A 401 mid-session (expired) → drop back to the login screen.
      api.onUnauthorized = () => {
        if (!get().needsAuth) set({ needsAuth: true, authUser: null })
      }
      try {
        const st: any = await api.authState()
        if (st.user) {
          set({ authUser: st.user, needsAuth: false })
        } else {
          set({ needsAuth: true, signupOpen: !!st.signupOpen, authUser: null, loading: false })
          return // logged out — the landing renders; don't load app data
        }
      } catch {
        set({ needsAuth: true, loading: false })
        return
      }
      await bootApp()
    },

    signin: async (username, password) => {
      try {
        const d: any = await api.signin({ username, password })
        if (d.error || !d.user) return d.error || "Sign-in failed"
        set({ needsAuth: false, authUser: d.user, error: null })
        await bootApp()
      } catch (e: any) {
        return e?.message || String(e)
      }
    },

    signup: async (username, password) => {
      try {
        const d: any = await api.signup({ username, password })
        if (d.error || !d.user) return d.error || "Sign-up failed"
        set({ needsAuth: false, authUser: d.user, signupOpen: false, error: null })
        await bootApp()
      } catch (e: any) {
        return e?.message || String(e)
      }
    },

    signout: async () => {
      stopTimers()
      await api.signout().catch(() => {})
      // Wipe every per-account view so the shell is clean, not stale (LHS
      // sessions, RHS skills/MCP, top-bar host/agent/session all reset).
      set({
        needsAuth: true, authUser: null, error: null,
        currentSessionPath: "", turns: [], droppedFile: null, parser: new SessionParser(),
        sessions: [], hosts: [], agents: [], caps: { skills: [], mcp: [] },
        meta: null, git: null, loops: [], fullSummary: null, analysis: null, analysisError: null,
        slashCommands: [], queue: [], chatRunning: false, chatStatus: null,
        panel: null, fsOpen: false, searchOpen: false,
      })
    },

    loadAgents: async () => {
      try {
        const d: any = await api.agents()
        if (d && Array.isArray(d.agents)) {
          set({ agents: d.agents })
          // The stored selection may point at a harness that's been disabled in
          // the registry — snap to the first enabled agent instead of an
          // invisible selection the dropdown can't show.
          const list = d.agents as AgentInfo[]
          if (list.length && !list.some((a) => a.id === get().currentAgent)) {
            get().setAgent(list[0].id)
          }
        }
      } catch {
        /* leave empty; picker falls back to Claude */
      }
    },
    // Install an agent CLI into $HOME/.local (no sudo) on the current host, then
    // switch to it. Directs the user to `<login>` in the Terminal for sign-in.
    installAgent: async (id) => {
      const a = get().agents.find((x) => x.id === id)
      set({ installing: id, chatStatus: { kind: "running", text: `Installing ${a?.label || id}…` } })
      try {
        const res = await api.agentsInstall({ agent: id })
        const d = await res.json()
        if (d.error || !d.ok || !d.installed) {
          throw new Error(d.error || `Install failed${d.returncode != null ? ` (exit ${d.returncode})` : ""}`)
        }
        await get().loadAgents()
        set({ installing: null })
        await get().setAgent(id)
        // Freshly installed → surface the in-app sign-in unless already logged in.
        const fresh = get().agents.find((x) => x.id === id)
        if (fresh && fresh.loggedIn === false) {
          get().startAgentLogin(id)
        } else {
          set({ chatStatus: { kind: "done", text: `Installed ${a?.label || id}.` } })
          setTimeout(() => { if (!get().chatRunning) set({ chatStatus: null }) }, 6000)
        }
      } catch (e: any) {
        set({ installing: null, chatStatus: { kind: "error", text: "Install failed: " + (e?.message || e) } })
      }
    },

    // Claude-style OAuth sign-in for an agent: the app surfaces the auth URL,
    // the user completes it in a new tab and pastes the callback URL back.
    startAgentLogin: async (id) => {
      const label = get().agents.find((a) => a.id === id)?.label || id
      set({ agentLogin: { agent: id, stage: "starting", url: null, error: "", code: null } })
      try {
        const d: any = await api.agentLoginStart({ agent: id })
        set({ agentLogin: { agent: id, stage: d.stage || "starting", url: d.url || null, error: d.error || "", code: d.code || null } })
      } catch (e: any) {
        set({ agentLogin: { agent: id, stage: "error", url: null, error: e?.message || String(e), code: null } })
        return
      }
      if (agentLoginTimer) clearInterval(agentLoginTimer)
      agentLoginTimer = setInterval(async () => {
        const cur = get().agentLogin
        if (!cur || cur.agent !== id) {
          if (agentLoginTimer) { clearInterval(agentLoginTimer); agentLoginTimer = null }
          return
        }
        try {
          const d: any = await api.agentLoginPoll(id)
          if (d.loggedIn || d.stage === "done") {
            if (agentLoginTimer) { clearInterval(agentLoginTimer); agentLoginTimer = null }
            await get().loadAgents()
            set({ agentLogin: null, chatStatus: { kind: "done", text: `Signed in to ${label}.` } })
            setTimeout(() => { if (!get().chatRunning) set({ chatStatus: null }) }, 6000)
          } else if (cur.stage !== "submitting") {
            set({ agentLogin: { ...cur, stage: d.stage, url: d.url || cur.url, note: d.note, code: d.code ?? cur.code } })
          }
        } catch {
          /* keep polling */
        }
      }, 2000)
    },

    submitAgentLogin: async (callback) => {
      const cur = get().agentLogin
      if (!cur) return
      const label = get().agents.find((a) => a.id === cur.agent)?.label || cur.agent
      set({ agentLogin: { ...cur, stage: "submitting", error: "" } })
      try {
        const d: any = await api.agentLoginSubmit({ agent: cur.agent, callback })
        if (d.error || (!d.ok && !d.loggedIn)) {
          throw new Error(d.error || "Sign-in didn't complete — re-copy the callback URL and try again.")
        }
        if (agentLoginTimer) { clearInterval(agentLoginTimer); agentLoginTimer = null }
        await get().loadAgents()
        set({ agentLogin: null, chatStatus: { kind: "done", text: `Signed in to ${label}.` } })
        setTimeout(() => { if (!get().chatRunning) set({ chatStatus: null }) }, 6000)
      } catch (e: any) {
        set({ agentLogin: { ...get().agentLogin!, stage: "url", error: e?.message || String(e) } })
      }
    },

    cancelAgentLogin: () => {
      if (agentLoginTimer) { clearInterval(agentLoginTimer); agentLoginTimer = null }
      const a = get().agentLogin?.agent
      if (a) api.agentLoginCancel({ agent: a }).catch(() => {})
      set({ agentLogin: null })
    },

    setAgent: async (id) => {
      if (id === get().currentAgent) return
      stopTimers()
      api.setAgent(id)
      localStorage.setItem("currentAgent", id)
      set({
        currentAgent: id, currentSessionPath: "", turns: [], loading: true, error: null,
        chatRunning: false, chatStatus: null, queue: [], analysis: null, analysisError: null,
      })
      try {
        const sessions = (await api.sessions()) as SessionListItem[]
        const list = Array.isArray(sessions) ? sessions : []
        set({ sessions: list, loading: false })
        if (list[0]) await get().loadSession(list[0].path)
      } catch (e: any) {
        set({ loading: false, error: String(e?.message || e) })
      }
    },

    refreshHosts: async () => {
      try {
        const hosts = (await api.hosts()) as HostInfo[]
        if (Array.isArray(hosts)) set({ hosts })
      } catch {
        /* leave existing list */
      }
    },

    setHost: async (hid) => {
      if (hid === get().currentHost) return
      stopTimers()
      api.setHost(hid)
      localStorage.setItem("currentHost", hid)
      set({ currentHost: hid, currentSessionPath: "", turns: [], loading: true, error: null, chatRunning: false, chatStatus: null })
      get().loadAgents() // install state is per-host
      try {
        const { hosts, sessions } = await reloadForHost()
        set({ hosts, sessions, loading: false })
        const open = pickOpen(sessions, hid)
        if (open) await get().loadSession(open)
      } catch (e: any) {
        set({ loading: false, error: "Cannot reach host — " + (e?.message || e) })
      }
    },

    // Render a session .jsonl dropped from disk — fully client-side (no server
    // session, no polling/driving). Uses the same parser as a live session.
    loadDroppedFile: async (file) => {
      stopTimers()
      try {
        const text = await file.text()
        const parser = new SessionParser()
        const turns: Turn[] = []
        for (const line of text.split("\n")) {
          if (!line.trim()) continue
          const r = parser.ingest(line, false)
          if (r?.turn) turns.push(r.turn)
        }
        set({
          droppedFile: file.name, currentSessionPath: "", turns, parser,
          loading: false, error: turns.length ? null : "No messages found in that file.",
          chatRunning: false, chatStatus: null, queue: [], analysis: null,
        })
      } catch (e: any) {
        set({ error: "Couldn't read file: " + (e?.message || e), loading: false })
      }
    },

    loadSession: async (path) => {
      stopTimers()
      analyzeBucket = null // reset auto-analysis baseline for the new session
      set({
        loading: true,
        error: null,
        droppedFile: null,
        currentSessionPath: path,
        chatStatus: null,
        chatRunning: false,
        queue: [],
        // Cleared on every load; only Claude refills it (loadCommands). Keeps
        // Claude's project/user commands from leaking into a Codex/Copilot "/".
        slashCommands: [],
        analysis: null,
        analysisLoading: false,
        analysisError: null,
        git: null,
      })
      try {
        const res = await api.sessionReadTail(path, TAIL_LINES)
        if (!res.ok) throw new Error("HTTP " + res.status)
        const d = await res.json()
        // A newer loadSession/setHost/setAgent may have superseded this one while
        // the read was in flight — don't clobber the current session with stale data.
        if (get().currentSessionPath !== path) return
        const parser = new SessionParser()
        const turns: Turn[] = []
        for (const line of d.lines as string[]) {
          const r = parser.ingest(line, false)
          if (r?.turn) turns.push(r.turn)
        }
        localStorage.setItem("lastSession:" + get().currentHost, path)
        set({ parser, turns, fileSize: d.size, headOffset: d.start, tailOffset: d.end, loading: false })
        startPolling()
        // Claude loads the full panel set; Codex reuses capabilities (skills +
        // MCP) and run-reattach but not the Claude-only summary/meta/loops.
        const ag = get().currentAgent
        if (ag === "claude") {
          reattach()
          get().loadCapabilities()
          get().loadCommands()
          get().loadSummary()
          get().loadMeta()
          get().loadLoops()
        } else if (ag === "codex" || ag === "copilot") {
          reattach()
          get().loadCapabilities()
        }
      } catch (e: any) {
        set({ loading: false, error: "Failed to load session: " + (e?.message || e) })
      }
    },

    loadCapabilities: async () => {
      const { currentSessionPath } = get()
      const params = new URLSearchParams()
      if (currentSessionPath) params.set("session", currentSessionPath)
      if (api.host && api.host !== "local") params.set("host", api.host)
      if (api.agent && api.agent !== "claude") params.set("agent", api.agent)
      set({ capsLoading: true })
      try {
        const caps = (await api.capabilities(params.toString())) as Capabilities
        if (get().currentSessionPath !== currentSessionPath) return
        if (caps && Array.isArray(caps.skills)) set({ caps })
      } catch {
        /* leave placeholders */
      } finally {
        if (get().currentSessionPath === currentSessionPath) set({ capsLoading: false })
      }
    },

    refreshAuth: async () => {
      try {
        const a = await api.authStatus()
        set({ auth: a })
      } catch {
        /* leave unknown */
      }
    },
    startLogin: async () => {
      set({ loginActive: true, loginUrl: "", loginNote: "Starting login…" })
      try {
        await (await api.authLoginStart()).json()
        watchLogin()
      } catch (e: any) {
        set({ loginNote: "Failed to start login: " + (e?.message || e) })
      }
    },
    submitLoginCode: async (code) => {
      if (!code.trim()) return
      set({ loginNote: "Verifying code…" })
      try {
        const res = await api.authLoginCode({ code: code.trim() })
        const d = await res.json()
        if (d.error) throw new Error(d.error)
      } catch (e: any) {
        set({ loginNote: "Error: " + (e?.message || e) })
      }
    },
    cancelLogin: () => {
      api.authLoginCancel().catch(() => {})
      if (loginTimer) { clearInterval(loginTimer); loginTimer = null }
      set({ loginActive: false, loginUrl: "", loginNote: "" })
    },

    openSearch: () => set({ searchOpen: true }),
    closeSearch: () => set({ searchOpen: false, searchQuery: "", searchMatches: [], searchIndex: 0 }),
    setSearchQuery: (q) => {
      const ql = q.trim().toLowerCase()
      const matches = ql
        ? get().turns.filter((t) => turnText(t).toLowerCase().includes(ql)).map((t) => t.domId)
        : []
      set({ searchQuery: q, searchMatches: matches, searchIndex: 0 })
    },
    searchNav: (dir) => {
      const { searchMatches, searchIndex } = get()
      if (!searchMatches.length) return
      set({ searchIndex: (searchIndex + dir + searchMatches.length) % searchMatches.length })
    },

    loadCommands: async () => {
      const { currentSessionPath } = get()
      const qs = currentSessionPath ? `?session=${encodeURIComponent(currentSessionPath)}` : ""
      try {
        const c = (await api.commands(qs)) as SlashCommand[]
        if (Array.isArray(c)) set({ slashCommands: c })
      } catch {
        /* ignore */
      }
    },

    loadSummary: async () => {
      const { currentSessionPath } = get()
      if (!currentSessionPath) return
      set({ fullSummary: null })
      try {
        const d = (await api.sessionSummary(currentSessionPath)) as SessionSummary
        if (get().currentSessionPath !== currentSessionPath) return
        if (d && !(d as any).error) set({ fullSummary: d })
      } catch {
        /* ignore */
      }
    },

    // On-demand LLM extraction of assumptions Claude made + decisions the user
    // made, via the viewer's local `claude -p`. Costs a few cents / ~20–30s.
    analyzeSession: async (refresh = false) => {
      const { currentSessionPath, analysisLoading } = get()
      if (!currentSessionPath || analysisLoading) return
      set({ analysisLoading: true, analysisError: null })
      try {
        const d: any = await api.sessionAnalysis(currentSessionPath, refresh)
        if (get().currentSessionPath !== currentSessionPath) return // switched away mid-analysis
        if (d?.error) throw new Error(d.error)
        const at = get().fullSummary?.userMessages ?? get().parser.stats.userMessages ?? 0
        analyzeBucket = Math.floor(at / 10) // next auto-run is the next multiple of 10
        set({
          analysis: { assumptions: d.assumptions || [], decisions: d.decisions || [], at },
          analysisLoading: false,
        })
      } catch (e: any) {
        set({ analysisError: e?.message || String(e), analysisLoading: false })
      }
    },

    // Re-analyze once the session crosses each new multiple of 10 user messages.
    maybeAutoAnalyze: () => {
      const { currentSessionPath, analysisLoading } = get()
      if (!currentSessionPath || analysisLoading) return
      const count = get().fullSummary?.userMessages ?? get().parser.stats.userMessages ?? 0
      const bucket = Math.floor(count / 10)
      if (analyzeBucket === null) {
        analyzeBucket = bucket // baseline — don't fire on load
        return
      }
      if (count > 0 && bucket > analyzeBucket) {
        analyzeBucket = bucket
        get().analyzeSession(true) // fresh transcript → re-run
      }
    },

    loadMeta: async () => {
      const { currentSessionPath } = get()
      if (!currentSessionPath) return
      try {
        const m = (await api.sessionMeta(currentSessionPath)) as SessionMeta
        set({ meta: m })
        get().loadGitStatus() // cwd just arrived — populate the git bar
      } catch {
        /* ignore */
      }
    },
    // Git repo/branch state for the session's cwd (drives the GitSection bar).
    loadGitStatus: async () => {
      const cwd = get().meta?.cwd
      if (!cwd) {
        set({ git: null })
        return
      }
      try {
        const g = (await api.gitStatus(cwd)) as GitStatus
        if (get().meta?.cwd !== cwd) return // switched sessions mid-fetch
        set({ git: g && g.repo ? g : null })
      } catch {
        /* keep last known state */
      }
    },
    saveMeta: async (field, value) => {
      const { currentSessionPath, meta } = get()
      if (!currentSessionPath) return
      set({ meta: { ...(meta || {}), [field]: value } })
      try {
        await (await api.sessionMetaSave({ session: currentSessionPath, [field]: value })).json()
      } catch {
        /* ignore */
      }
    },
    loadLoops: async () => {
      const sid = sessionIdOf(get().currentSessionPath)
      if (!sid) return
      try {
        const l = (await api.loops(sid)) as Loop[]
        if (Array.isArray(l)) set({ loops: l })
      } catch {
        /* ignore */
      }
    },
    createLoop: async (prompt, interval, model) => {
      const { currentSessionPath } = get()
      if (!prompt.trim()) return
      const res = await api.loopsCreate({ session: currentSessionPath, prompt, interval, model })
      await res.json().catch(() => ({}))
      get().loadLoops()
    },
    deleteLoop: async (id) => {
      await api.loopsDelete(id).catch(() => {})
      set({ loops: get().loops.filter((l) => l.id !== id) })
    },
    toggleVisible: (t) => set({ visible: { ...get().visible, [t]: !get().visible[t] } }),

    loadProjects: async () => {
      try {
        const p = (await api.projects()) as ProjectDir[]
        if (Array.isArray(p)) set({ projects: p })
      } catch {
        /* ignore */
      }
    },

    startNewSession: async ({ cwd, message, title, systemPrompt, goal }) => {
      const { permMode, model } = get()
      if (!agentPreflight()) return
      set({ chatRunning: true, chatStatus: null })
      try {
        const res = await api.newSession({
          cwd,
          message,
          mode: permMode,
          model,
          title: title || "",
          systemPrompt: systemPrompt || "",
          goal: goal || "",
        })
        const d = await res.json()
        if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`)
        watchNewSession(d.session, title, d.path)
      } catch (e: any) {
        set({ chatRunning: false, chatStatus: { kind: "error", text: "Failed to start: " + (e?.message || e) } })
      }
    },

    renameCurrent: async (title) => {
      const { currentSessionPath } = get()
      if (!currentSessionPath || !title.trim()) return
      const res = await api.renameSession({ session: currentSessionPath, title: title.trim() })
      const d = await res.json().catch(() => ({}))
      if (!d.error) api.sessions().then((s: any) => Array.isArray(s) && set({ sessions: s })).catch(() => {})
    },

    deleteByPath: async (path) => {
      const res = await api.deleteSession({ session: path })
      await res.json().catch(() => ({}))
      const sessions = (await api.sessions().catch(() => [])) as SessionListItem[]
      set({ sessions: Array.isArray(sessions) ? sessions : [] })
      if (get().currentSessionPath === path) {
        const open = sessions[0]?.path
        if (open) get().loadSession(open)
        else set({ currentSessionPath: "", turns: [] })
      }
    },

    loadOlder: async () => {
      const { currentSessionPath, headOffset, parser, turns, loadingOlder } = get()
      if (loadingOlder || headOffset <= 0 || !currentSessionPath) return
      set({ loadingOlder: true })
      try {
        const res = await api.sessionReadBefore(currentSessionPath, headOffset, CHUNK_LINES)
        if (res.ok) {
          const d = await res.json()
          const older: Turn[] = []
          for (const line of d.lines as string[]) {
            const r = parser.ingest(line, true)
            if (r?.turn) older.push(r.turn)
          }
          set({ turns: [...older, ...turns], headOffset: d.start })
        }
      } catch {
        /* ignore */
      } finally {
        set({ loadingOlder: false })
      }
    },

    setLhsTab: (t) => { localStorage.setItem("lhsTab", t); set({ lhsTab: t }) },
    setRhsTab: (t) => { localStorage.setItem("rhsTab", t); set({ rhsTab: t }) },
    setPermMode: (m) => { localStorage.setItem("permMode", m); set({ permMode: m }) },
    setModel: (m) => { localStorage.setItem("model", m); set({ model: m }) },

    sendChat: async (msg) => {
      const { currentSessionPath, chatRunning, permMode, model, currentAgent } = get()
      if (!msg.trim() || !currentSessionPath) return
      // A run is active → queue for the next turn (TUI parity).
      if (chatRunning) {
        const res = await api.chat({ path: currentSessionPath, message: msg, queue: true, agent: currentAgent })
        const d = await res.json().catch(() => ({}))
        if (res.ok && !d.error) set({ queue: [...get().queue, msg] })
        return
      }
      // Not installed / not signed in on this host → guide instead of failing.
      if (!agentPreflight()) return msg
      set({ chatRunning: true, chatStatus: null })
      try {
        const res = await api.chat({ path: currentSessionPath, message: msg, mode: permMode, model, agent: currentAgent })
        const d = await res.json()
        if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`)
        await pollTick()
        watchChat(d.session)
      } catch (e: any) {
        set({ chatRunning: false, chatStatus: { kind: "error", text: "Failed to send: " + (e?.message || e) } })
        return msg // let the composer restore the text
      }
    },

    interruptRun: async () => {
      const { currentSessionPath } = get()
      if (!currentSessionPath) return
      try {
        await api.chatInterrupt({ path: currentSessionPath })
      } catch {
        /* ignore */
      }
    },

    // Answer a pending tool-permission request (Ask mode). Optimistically drop
    // the card; the poll reconciles from the backend's pending_approvals.
    decidePermission: async (id, decision) => {
      const sid = sessionIdOf(get().currentSessionPath)
      set({ pendingApprovals: get().pendingApprovals.filter((p) => p.id !== id) })
      try {
        await api.chatPermissionDecide({ session: sid, id, decision })
      } catch {
        /* the run will time out and deny if this never lands */
      }
    },

    clearPendingDraft: () => set({ pendingDraft: null }),

    // Fork a new session branching from just before a message (non-destructive);
    // the message lands in the composer of the fork to edit and resend.
    forkFromMessage: async (uuid) => {
      const { currentSessionPath, chatRunning, sessions, parser } = get()
      if (!currentSessionPath || chatRunning) return
      const base = parser.metadata.title || sessions.find((s) => s.path === currentSessionPath)?.title || "Session"
      try {
        const res = await api.forkSession({ session: currentSessionPath, uuid, title: `${base} (fork)` })
        const d = await res.json()
        if (d.error) throw new Error(d.error)
        api.sessions().then((s: any) => { if (Array.isArray(s)) set({ sessions: s }) }).catch(() => {})
        await get().loadSession(d.path)
        set({ pendingDraft: d.message || "", chatStatus: { kind: "done", text: "Forked — edit the message and send." } })
        setTimeout(() => { if (!get().chatRunning) set({ chatStatus: null }) }, 6000)
      } catch (e: any) {
        set({ chatStatus: { kind: "error", text: "Fork failed: " + (e?.message || e) } })
      }
    },

    // Restore to just before a message. `mode` mirrors Claude Code's /rewind:
    // "conversation" truncates the transcript (backup kept, message returns to
    // the composer); "code" reverts tracked files to their checkpoint (working
    // copies backed up first); "code+conversation" does both. All are destructive
    // but reversible via the backups.
    revertToMessage: async (uuid, mode = "conversation") => {
      const { currentSessionPath, chatRunning } = get()
      if (!currentSessionPath || chatRunning) return
      try {
        const res = await api.restoreSession({ session: currentSessionPath, uuid, mode })
        const d = await res.json()
        if (d.error) throw new Error(d.error)
        const truncated = mode === "conversation" || mode === "code+conversation"
        if (truncated) await get().loadSession(currentSessionPath)
        const n = d.code?.restored?.length ?? 0
        const codeNote = mode !== "conversation" ? ` · ${n} file${n === 1 ? "" : "s"} reverted` : ""
        const tail = truncated ? " — the message is back in the input." : " — code reverted to this checkpoint."
        set({
          pendingDraft: truncated ? d.message || "" : get().pendingDraft,
          chatStatus: { kind: "done", text: `Restored${d.backup ? " · backup kept" : ""}${codeNote}${tail}` },
        })
        setTimeout(() => { if (!get().chatRunning) set({ chatStatus: null }) }, 6000)
      } catch (e: any) {
        set({ chatStatus: { kind: "error", text: "Restore failed: " + (e?.message || e) } })
      }
    },

    removeQueued: async (i) => {
      const { currentSessionPath } = get()
      await api.chatQueueRemove({ path: currentSessionPath, index: i }).catch(() => {})
      set({ queue: get().queue.filter((_, idx) => idx !== i) })
    },

    steerMessage: async (msg) => {
      const { currentSessionPath } = get()
      if (!msg.trim() || !currentSessionPath) return
      try {
        const res = await api.chatSteer({ path: currentSessionPath, message: msg })
        const d = await res.json()
        if (d.error) throw new Error(d.error)
        set({
          chatStatus: {
            kind: "done",
            text:
              d.outcome === "steered"
                ? "Steered into the current turn"
                : "Turn was finishing — queued for the next turn",
          },
        })
        setTimeout(() => {
          const st = get().chatStatus
          if (st && st.kind === "done") set({ chatStatus: null })
        }, 4000)
      } catch (e: any) {
        set({ chatStatus: { kind: "error", text: "Steer failed: " + (e?.message || e) } })
        return msg
      }
    },

    addStash: (text) => {
      if (!text.trim()) return
      const stash = [text.trim(), ...get().stash.filter((s) => s !== text.trim())].slice(0, 50)
      localStorage.setItem("stash", JSON.stringify(stash))
      set({ stash })
    },
    removeStash: (i) => {
      const stash = get().stash.filter((_, idx) => idx !== i)
      localStorage.setItem("stash", JSON.stringify(stash))
      set({ stash })
    },

    openPanel: (k) => {
      // Persist so a refresh restores the open panel; opening the general
      // terminal clears any interactive-session target (back to the host shell).
      localStorage.setItem("panel", k)
      if (k === "terminal") {
        localStorage.removeItem("termInit")
        set({ panel: k, termInit: null })
      } else {
        set({ panel: k })
      }
    },
    closePanel: () => {
      localStorage.removeItem("panel")
      set({ panel: null })
    },
    continueInteractively: (cmd, key) => {
      localStorage.setItem("panel", "terminal")
      localStorage.setItem("termInit", JSON.stringify({ key, cmd }))
      set({ panel: "terminal", termInit: { key, cmd } })
    },
    openFs: () => set({ fsOpen: true, fsPick: null }),
    pickDir: (cb) => set({ fsOpen: true, fsPick: cb }),
    closeFs: () => set({ fsOpen: false, fsPick: null }),
    toggleFloating: () => {
      const v = !get().panelFloating
      localStorage.setItem("panelFloating", v ? "1" : "0")
      set({ panelFloating: v })
    },
    setFloatRect: (r) => {
      localStorage.setItem("floatRect", JSON.stringify(r))
      set({ floatRect: r })
    },
    setDockSplit: (n) => {
      const v = Math.min(0.85, Math.max(0.15, n))
      localStorage.setItem("dockSplit", String(v))
      set({ dockSplit: v })
    },
  }
})
