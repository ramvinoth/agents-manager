/** The run engine every slice shares: transcript polling, chat-run watching,
 *  new-session resolution, boot, and the non-Claude agent preflight. Timers are
 *  module-level so they never trigger re-renders. */
import { api } from "../lib/api"
import { describeHost } from "../lib/host"
import { applyTheme, writeThemeChoice } from "../lib/theme"
import type { GetState, SetState } from "./types"
import { pickOpen, reloadForHost, sessionIdOf } from "./helpers"

const POLL_MS = 2000
const CHAT_POLL_MS = 1500

let pollTimer: ReturnType<typeof setInterval> | null = null
let chatTimer: ReturnType<typeof setInterval> | null = null
let nsTimer: ReturnType<typeof setInterval> | null = null
let polling = false
// Slow git-status refresh: every N poll ticks (catches branch switches made in
// a terminal), on top of the immediate refreshes on session load / run end.
let gitTick = 0

export type Runtime = ReturnType<typeof createRuntime>

export function createRuntime(set: SetState, get: GetState) {
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
    api.health().then((h) => set({ serverVersion: h.version })).catch(() => {})
    get().loadAgents()
    get().loadProviders() // global provider library — session-independent
    get().loadOrchestration() // master switch + loop mode (gates the Harman UI)
    api.getPrefs().then((p: any) => {
      // A server-side theme is a cross-device preference, so it wins, but only
      // when it says something: absent leaves the local choice (or the dark
      // default) as the pre-paint script set it.
      if (p && (p.theme === "dark" || p.theme === "light")) {
        writeThemeChoice(p.theme)
        applyTheme(p.theme === "dark")
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

  // The session's name is stored by the server at creation; no rename here.
  function watchNewSession(sid: string, immediatePath?: string) {
    const open = async (path: string) => {
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
        // Refresh the full-session summary (fresh user-message count) without a null-flash.
        try {
          const sum: any = await api.sessionSummary(get().currentSessionPath)
          if (sum && !sum.error) set({ fullSummary: sum })
        } catch {
          /* keep stale summary */
        }
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
    }, CHAT_POLL_MS)
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

  return { stopTimers, bootApp, pollTick, startPolling, watchChat, watchNewSession, reattach, agentPreflight }
}
