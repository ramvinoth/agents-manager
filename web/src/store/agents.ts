/** Which harness (Claude, Codex, Copilot) and which host the app drives: install, sign-in, switching. */
import { api } from "../lib/api"
import type { AgentInfo, HostInfo, SessionListItem } from "../lib/types"
import type { Slice } from "./types"
import { pickOpen, reloadForHost } from "./helpers"

let agentLoginTimer: ReturnType<typeof setInterval> | null = null

export interface AgentsSlice {
  agents: AgentInfo[]
  currentAgent: string
  installing: string | null
  agentLogin: { agent: string; stage: string; url: string | null; error: string; note?: string; code?: string | null } | null
  hosts: HostInfo[]
  currentHost: string
  loadAgents: () => Promise<void>
  setAgent: (id: string) => Promise<void>
  installAgent: (id: string) => Promise<void>
  startAgentLogin: (id: string) => Promise<void>
  submitAgentLogin: (callback: string) => Promise<void>
  cancelAgentLogin: () => void
  setHost: (hid: string) => Promise<void>
  refreshHosts: () => Promise<void>
}

export const createAgentsSlice: Slice<AgentsSlice> = (set, get, rt) => {
  const { stopTimers } = rt
  return {
    agents: [],
    currentAgent: localStorage.getItem("currentAgent") || "claude",
    installing: null,
    agentLogin: null,
    hosts: [],
    currentHost: localStorage.getItem("currentHost") || "local",
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
    setAgent: async (id) => {
      if (id === get().currentAgent) return
      stopTimers()
      api.setAgent(id)
      localStorage.setItem("currentAgent", id)
      set({
        currentAgent: id, currentSessionPath: "", turns: [], loading: true, error: null,
        chatRunning: false, chatStatus: null, queue: [],
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
    setHost: async (hid) => {
      if (hid === get().currentHost) return
      stopTimers()
      api.setHost(hid)
      localStorage.setItem("currentHost", hid)
      set({ currentHost: hid, currentSessionPath: "", turns: [], loading: true, error: null, chatRunning: false, chatStatus: null, mcpProbes: {} })
      get().loadAgents() // install state is per-host
      get().loadDesktop() // only the local deployment has an embeddable desktop
      try {
        const { hosts, sessions } = await reloadForHost()
        set({ hosts, sessions, loading: false })
        const open = pickOpen(sessions, hid)
        if (open) await get().loadSession(open)
      } catch (e: any) {
        set({ loading: false, error: "Cannot reach host — " + (e?.message || e) })
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
  }
}
