/** The open session's side panels: capabilities, slash commands, summary, analysis, meta, AI config, git. */
import { api } from "../lib/api"
import type { AIConfig } from "../lib/aiSelection"
import type { Capabilities, GitStatus, SessionAnalysis, SessionMeta, SessionSummary, SlashCommand } from "../lib/types"
import type { Slice } from "./types"
import { sessionIdOf } from "./helpers"

// Per-session baseline for auto-analysis: the 10-user-message bucket last seen.
// null means "not yet observed" so we never fire on load, only on new crossings.
let analyzeBucket: number | null = null
/** Called when another session opens: its first observation becomes the new baseline. */
export function resetAnalyzeBucket() {
  analyzeBucket = null
}

export interface DetailsSlice {
  caps: Capabilities
  capsLoading: boolean
  slashCommands: SlashCommand[]
  fullSummary: SessionSummary | null
  analysis: SessionAnalysis | null
  analysisLoading: boolean
  analysisError: string | null
  meta: SessionMeta | null
  /** The session's AI selection (provider/model/mode/effort) as the server
   *  holds it — null until loaded or when the harness has no AI settings. */
  sessionAI: AIConfig | null
  git: GitStatus | null
  loadCapabilities: () => Promise<void>
  loadCommands: () => Promise<void>
  loadSummary: () => Promise<void>
  analyzeSession: (refresh?: boolean) => Promise<void>
  maybeAutoAnalyze: () => void
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
    analysis: null,
    analysisLoading: false,
    analysisError: null,
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
