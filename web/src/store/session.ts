/** The open transcript and the session list: load, page older lines, create, rename, delete, search. */
import { api } from "../lib/api"
import { SessionParser } from "../lib/parser"
import type { SessionListItem, Turn, VisibleTypes } from "../lib/types"
import type { Slice, ProjectDir, NewSessionOpts } from "./types"
import { turnText, TAIL_LINES, CHUNK_LINES } from "./helpers"
import { resetAnalyzeBucket } from "./details"

export interface SessionSlice {
  sessions: SessionListItem[]
  currentSessionPath: string
  turns: Turn[]
  parser: SessionParser
  fileSize: number
  headOffset: number
  tailOffset: number
  loading: boolean
  loadingOlder: boolean
  error: string | null
  droppedFile: string | null
  projects: ProjectDir[]
  visible: VisibleTypes
  searchOpen: boolean
  searchQuery: string
  searchMatches: string[]
  searchIndex: number
  loadSession: (path: string) => Promise<void>
  loadDroppedFile: (file: File) => Promise<void>
  loadOlder: () => Promise<void>
  loadProjects: () => Promise<void>
  startNewSession: (opts: NewSessionOpts) => Promise<void>
  renameCurrent: (title: string) => Promise<void>
  deleteByPath: (path: string) => Promise<void>
  toggleVisible: (t: keyof VisibleTypes) => void
  openSearch: () => void
  closeSearch: () => void
  setSearchQuery: (q: string) => void
  searchNav: (dir: number) => void
}

export const createSessionSlice: Slice<SessionSlice> = (set, get, rt) => {
  const { stopTimers, startPolling, watchNewSession, reattach, agentPreflight } = rt
  return {
    sessions: [],
    currentSessionPath: "",
    turns: [],
    parser: new SessionParser(),
    fileSize: 0,
    headOffset: 0,
    tailOffset: 0,
    loading: false,
    loadingOlder: false,
    error: null,
    droppedFile: null,
    projects: [],
    visible: { user: true, assistant: true, system: true, tools: true },
    searchOpen: false,
    searchQuery: "",
    searchMatches: [],
    searchIndex: 0,
    loadSession: async (path) => {
      stopTimers()
      resetAnalyzeBucket()
      // Mark read for this reader: clear the dot optimistically and advance the
      // server-side per-reader cursor, so it stays read on the next list refresh
      // and on every other device/principal-shared surface. No-op if already read.
      if (get().sessions.some((s) => s.path === path && s.unread)) {
        set({ sessions: get().sessions.map((s) => (s.path === path ? { ...s, unread: false } : s)) })
      }
      api.sessionSeen(path).catch(() => {})
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
        watchNewSession(d.session, d.path)
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
    toggleVisible: (t) => set({ visible: { ...get().visible, [t]: !get().visible[t] } }),
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
  }
}
