/** The open session's side panels: capabilities, slash commands, summary, meta, AI config, git. */
import { api } from "../lib/api"
import type { AIConfig } from "../lib/aiSelection"
import type { Capabilities, GitStatus, SessionMeta, SessionSummary, SlashCommand } from "../lib/types"
import { isRunning } from "../lib/mcp"
import type { ProbeEntry, ProbeResult } from "../lib/mcp"
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
  /** Per-server MCP probe state, keyed by server name. Absent = never tested.
   *  Cleared with the capability list it describes (see loadCapabilities). */
  mcpProbes: Record<string, ProbeEntry>
  /** Handshake with one MCP server and record the result. Manual only. */
  probeMcp: (name: string) => Promise<void>
  probeAllMcp: () => Promise<void>
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
    mcpProbes: {},
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
        // Probe results are dropped with the list they describe: a result is a
        // statement about one server on one host at one moment.
        if (caps && Array.isArray(caps.skills)) set({ caps, mcpProbes: {} })
      } catch {
        /* leave placeholders */
      } finally {
        if (get().currentSessionPath === currentSessionPath) set({ capsLoading: false })
      }
    },
    probeMcp: async (name) => {
      const server = get().caps.mcp.find((m) => m.name === name)
      if (!server || isRunning(get().mcpProbes[name])) return
      const { currentSessionPath, currentHost } = get()
      set((s) => ({ mcpProbes: { ...s.mcpProbes, [name]: { running: true } } }))
      let result: ProbeResult
      try {
        result = (await api.mcpProbe({ name, config: server.config, session: currentSessionPath })) as ProbeResult
        if (!result || typeof result.state !== "string") throw new Error("Malformed probe response")
      } catch (e: any) {
        // The probe never fails a request itself — this is the transport dying.
        // Say that, rather than blaming the MCP server.
        result = {
          name, transport: server.transport || "", state: "failed",
          error: "Could not reach the server: " + (e?.message || String(e)),
          detail: "", tools: [], server: {}, elapsed_ms: 0,
        }
      }
      // A late answer must not land against a different host's or chat's list.
      const now = get()
      if (now.currentHost !== currentHost || now.currentSessionPath !== currentSessionPath) return
      set((s) => ({ mcpProbes: { ...s.mcpProbes, [name]: result } }))
    },
    probeAllMcp: async () => {
      // Bounded fan-out: rows settle independently, but never 20 sockets at once.
      const queue = get().caps.mcp.map((m) => m.name)
      const worker = async () => {
        for (let n = queue.shift(); n !== undefined; n = queue.shift()) await get().probeMcp(n)
      }
      await Promise.all([worker(), worker(), worker()])
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
