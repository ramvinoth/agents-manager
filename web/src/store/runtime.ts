/** The run engine every slice shares: transcript reads, chat-run watching,
 *  new-session resolution, boot, and the non-Claude agent preflight. Timers are
 *  module-level so they never trigger re-renders.
 *
 *  The session events socket (/api/events/ws, lib/sessionEvents) says WHEN to
 *  read: the open transcript grew, its run started / ended / moved, the chat
 *  list changed. While it is up — and the server confirmed it sees the open
 *  transcript — the timers below fetch nothing; while it is down they are the
 *  fallback: every tick during a run, a slow cadence while idle. */
import { api } from "../lib/api"
import { describeHost } from "../lib/host"
import { applyTheme, writeThemeChoice } from "../lib/theme"
import { SocketFeed, socketUrl } from "../lib/socketFeed"
import { parseSessionEvent, pollStatus, pollTranscript, reactTo, settlesNewChat, watchFrame } from "../lib/sessionEvents"
import { watchLive } from "../components/useLive"
import type { GetState, SetState } from "./types"
import { pickOpen, reloadForHost, sessionIdOf } from "./helpers"

const POLL_MS = 2000
const CHAT_POLL_MS = 1500
/** The server pings every 25s (orchestrator/events.py PING_EVERY); two missed = dead. */
const EVENTS_STALE_MS = 60_000
/** Git has no event: a run's own commits refresh it at run end; a terminal's
 *  branch switch shows up within this. */
const GIT_EVERY_MS = 30_000
/** Org approvals re-checked every N fallback ticks, only while the stream is down. */
const RED_EVERY = 5

let pollTimer: ReturnType<typeof setInterval> | null = null
let chatTimer: ReturnType<typeof setInterval> | null = null
let nsTimer: ReturnType<typeof setInterval> | null = null
let polling = false
let listing = false
let tick = 0
let lastGit = 0

const feed = new SocketFeed(() => new WebSocket(socketUrl("/api/events/ws")), EVENTS_STALE_MS)
let feedOff: (() => void) | null = null
let redOff: (() => void) | null = null
/** The events stream is up (its hello arrived). */
let live = false
/** Sessions the server answered `watching ok` for since the last watch frame. */
const seen = new Set<string>()
/** A chat being created: its id, until /api/resolve finds its transcript. */
let pendingNew = ""

export type Runtime = ReturnType<typeof createRuntime>

export function createRuntime(set: SetState, get: GetState) {
  function stopTimers() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    if (chatTimer) { clearInterval(chatTimer); chatTimer = null }
    endNew()
  }

  // Load everything once we're authenticated (called from init and after login).
  async function bootApp() {
    const host = get().currentHost
    api.setHost(host)
    api.setAgent(get().currentAgent)
    api.authStatus().then((a) => set({ auth: a })).catch(() => {})
    api.health().then((h) => set({ serverVersion: h.version })).catch(() => {})
    get().loadAgents()
    get().loadDesktop()
    get().loadProviders() // global provider library — session-independent
    get().loadOrchestration() // master switch + loop mode (gates the Manager UI)
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
  /** Open a chat just created once its transcript exists. Live, the new run's
   *  events (turn-start, its file's first bytes, turn-end on a failed start)
   *  trigger the /api/resolve lookup; the 1s interval asks only while the
   *  stream is down. */
  function watchNewSession(sid: string, immediatePath?: string) {
    const open = async (path: string) => {
      await get().loadSession(path)
      refreshList()
      set({ chatRunning: true, chatStatus: null })
      watchChat(sessionIdOf(path))
    }
    if (nsTimer) { clearInterval(nsTimer); nsTimer = null }
    // Codex returns the rollout path up front (the session already exists), so
    // open it directly instead of resolving (a Claude-only lookup).
    if (immediatePath) { pendingNew = ""; open(immediatePath); return }
    pendingNew = sid
    nsOpen = open
    resolveNew()
    nsTimer = setInterval(() => { if (!live) resolveNew() }, 1000)
  }

  let nsOpen: ((path: string) => Promise<void>) | null = null
  let resolving = false

  async function resolveNew() {
    const sid = pendingNew
    if (!sid || resolving) return
    resolving = true
    try {
      const d: any = await api.resolve(sid)
      if (pendingNew !== sid) return // superseded by another new chat
      if (d.found) {
        endNew()
        await nsOpen?.(d.path)
      } else if (!d.running) {
        endNew()
        set({
          chatRunning: false,
          chatStatus: { kind: "error", text: d.stderr ? "claude: " + d.stderr.slice(-400) : "Session failed to start" },
        })
      }
    } catch {
      /* keep trying: the next event or tick asks again */
    } finally {
      resolving = false
    }
  }

  function endNew() {
    pendingNew = ""
    if (nsTimer) { clearInterval(nsTimer); nsTimer = null }
  }

  /** Read the open transcript's new lines. Skipped while a session load is in
   *  flight: its tail offset still belongs to the previous chat. */
  async function pollTick() {
    const { currentSessionPath, tailOffset, parser, turns, loading } = get()
    if (polling || loading || !currentSessionPath) return
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
    } catch {
      /* transient; retry next tick */
    } finally {
      polling = false
    }
  }

  /** One fallback tick: read the transcript only when the stream does not
   *  cover it, refresh git on its slow cadence, and re-check org approvals
   *  (the inline chip — decided in the Inbox or on the phone) only while the
   *  stream is down; live, the approvals table's row events drive it. */
  function fallbackTick() {
    tick++
    const sid = sessionIdOf(get().currentSessionPath)
    if (pollTranscript(live, seen.has(sid), get().chatRunning, tick)) pollTick()
    refreshGit()
    if (!live && tick % RED_EVERY === 0 && !chatTimer) refreshRed()
  }

  function refreshGit(now = false) {
    const t = Date.now()
    // With no repo yet, re-check four times slower, so a repo cloned into the
    // workspace during the session shows up without a reload.
    if (!now && t - lastGit < (get().git?.repo ? GIT_EVERY_MS : GIT_EVERY_MS * 4)) return
    lastGit = t
    get().loadGitStatus()
  }

  /** Take a chatStatus reply's open org approvals — only if it is still the
   *  open session's (the user may have switched chats during the fetch). */
  function applyRed(sessionId: string, d: any) {
    if (sessionIdOf(get().currentSessionPath) === sessionId) set({ pendingRed: d?.pending_red || [] })
  }

  async function refreshRed() {
    const sid = sessionIdOf(get().currentSessionPath)
    if (!sid) return
    try {
      applyRed(sid, await api.chatStatus(sid))
    } catch {
      /* transient; retry next tick */
    }
  }

  /** Tell the server which transcript this tab has open, so it reports that
   *  file's growth even when no run of this server writes it (a CLI in a
   *  terminal, a session on another host). Sent on every (re)connect and
   *  session load; it replaces the previous one. */
  function sendWatch() {
    const { currentSessionPath, currentHost, currentAgent } = get()
    const sid = sessionIdOf(currentSessionPath)
    seen.clear()
    feed.send(watchFrame(sid ? [{ session: sid, host: currentHost, agent: currentAgent, path: currentSessionPath }] : []))
  }

  /** Refetch the chat list of the host on screen. list-changed covers every
   *  run this server drives on any host (its turn boundaries) plus this
   *  machine's session files, so a remote host's list follows it too. */
  async function refreshList() {
    if (listing) return
    const host = get().currentHost
    listing = true
    try {
      const s: any = await api.sessions()
      if (Array.isArray(s) && get().currentHost === host) set({ sessions: s })
    } catch {
      /* the next change or reload catches up */
    } finally {
      listing = false
    }
  }

  /** Events may have been missed (first connect, reconnect, server resync):
   *  read everything they would have told us about. */
  function catchUp() {
    const sid = sessionIdOf(get().currentSessionPath)
    if (sid) {
      pollTick()
      checkRun(sid)
    }
    refreshList()
    resolveNew()
  }

  function onEvent(raw: string) {
    const ev = parseSessionEvent(raw)
    if (!ev) return
    if (ev.type === "hello") {
      live = true
      sendWatch()
      catchUp()
      return
    }
    if (ev.type === "watching") {
      if (ev.ok) seen.add(ev.session)
      else seen.delete(ev.session)
      return
    }
    if (settlesNewChat(ev, pendingNew)) resolveNew()
    const sid = sessionIdOf(get().currentSessionPath)
    switch (reactTo(ev, sid)) {
      case "transcript":
        pollTick()
        break
      case "status":
        checkRun(sid)
        break
      case "list":
        refreshList()
        break
      case "catch-up":
        catchUp()
        break
    }
  }

  /** Subscribe once per signed-in page; session switches keep the socket. */
  function ensureFeed() {
    if (feedOff) return
    feedOff = feed.subscribe({
      onMessage: onEvent,
      onClose: () => { live = false; seen.clear() },
    })
    redOff = watchLive(["approvals"], null, refreshRed)
  }

  /** Sign-out: close the stream (it would only retry into 403s). */
  function stopFeed() {
    feedOff?.()
    feedOff = null
    redOff?.()
    redOff = null
    live = false
    seen.clear()
  }

  function startPolling() {
    ensureFeed()
    if (live) sendWatch()
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(fallbackTick, POLL_MS)
  }

  /** Ask the server about the open session's run. Running: show it (a run
   *  started elsewhere — the phone, a loop — is adopted) and its queue and
   *  asks. Ended while we were showing it: finish it — final read, git,
   *  summary, Done or the error. Status events call this while the stream is
   *  up; watchChat's interval while it is down. */
  async function checkRun(sessionId: string) {
    try {
      const d: any = await api.chatStatus(sessionId)
      applyRed(sessionId, d)
      if (sessionIdOf(get().currentSessionPath) !== sessionId) return
      if (d.running) {
        if (!get().chatRunning) set({ chatRunning: true, chatStatus: null })
        set({ queue: d.queue || [], pendingApprovals: d.pending_approvals || [] })
        if (!chatTimer) watchChat(sessionId)
        return
      }
      if (!chatTimer) return // no run was being shown: nothing to finish
      clearInterval(chatTimer)
      chatTimer = null
      set({ chatRunning: false, queue: [], pendingApprovals: [] })
      await pollTick()
      refreshGit(true) // the run may have committed / switched branches
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
  }

  /** Watch a run of the open session to its end. The interval asks only while
   *  the stream is down; live, the run's status events call checkRun. */
  function watchChat(sessionId: string) {
    if (chatTimer) clearInterval(chatTimer)
    chatTimer = setInterval(() => {
      if (pollStatus(live)) checkRun(sessionId)
    }, CHAT_POLL_MS)
  }

  async function reattach() {
    const sid = sessionIdOf(get().currentSessionPath)
    set({ pendingRed: [] }) // never show the previous chat's asks
    if (!sid) return
    try {
      const d: any = await api.chatStatus(sid)
      applyRed(sid, d)
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

  return { stopTimers, stopFeed, bootApp, pollTick, startPolling, watchChat, watchNewSession, reattach, agentPreflight }
}
