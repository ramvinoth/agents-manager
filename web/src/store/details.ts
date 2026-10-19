/** The open session's side panels: capabilities, slash commands, summary, meta, AI config, git. */
import { api } from "../lib/api"
import type { AIConfig } from "../lib/aiSelection"
import type { Capabilities, GitStatus, SessionMeta, SessionSummary, SlashCommand } from "../lib/types"
import type { Slice } from "./types"
import { sessionIdOf } from "./helpers"

export interface DetailsSlice {
  caps: Capabilities
  capsLoading: boolean
  slashCommands: SlashCommand[]
  fullSummary: SessionSummary | null
  meta: SessionMeta | null
  /** The session's AI selection (provider/model/mode/effort) as the server
   *  holds it — null until loaded or when the harness has no AI settings. */
  sessionAI: AIConfig | null
  git: GitStatus | null
  loadCapabilities: () => Promise<void>
  loadCommands: () => Promise<void>
  loadSummary: () => Promise<void>
  loadMeta: () => Promise<void>
  saveMeta: (field: "goal" | "systemPrompt", value: string) => Promise<void>
  /** Cache the result of a successful AI save (the dialog already has it). */
  setSessionAI: (config: AIConfig) => void
  loadGitStatus: () => Promise<void>
}

export const createDetailsSlice: Slice<DetailsSlice> = (set, get) => {
  return {
    caps: { skills: [], mcp: [] },
    capsLoading: false,
    slashCommands: [],
    fullSummary: null,
    meta: null,
    sessionAI: null,
    git: null,
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
      // The AI selection is a separate, revisioned document (viewer/ai.py) —
      // read it from its own route, never from the legacy meta fields.
      try {
        const c = await api.aiConfig({ id: sessionIdOf(currentSessionPath), host: get().currentHost, agent: get().currentAgent })
        if (get().currentSessionPath === currentSessionPath) set({ sessionAI: c })
      } catch {
        set({ sessionAI: null })
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
    setSessionAI: (config) => set({ sessionAI: config }),
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
  }
}
