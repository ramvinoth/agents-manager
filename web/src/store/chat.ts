/** Driving a run: send, queue, steer, interrupt, approvals/questions/plans, fork and restore. */
import { api } from "../lib/api"
import type { Slice, ChatStatus, PermApproval, RestoreMode } from "./types"
import { sessionIdOf } from "./helpers"

/** The composer's permission mode until the owner picks another (Claude's id). */
export const DEFAULT_PERM_MODE = "bypassPermissions"
// v2: Bypass became the default; the old "permMode" key held the previous
// default, so it is dropped once and everyone starts in Bypass.
const PERM_MODE_KEY = "permMode.v2"
localStorage.removeItem("permMode")

export interface ChatSlice {
  chatRunning: boolean
  chatStatus: ChatStatus | null
  queue: string[]
  pendingApprovals: PermApproval[]
  stash: string[]
  permMode: string
  model: string
  pendingDraft: string | null
  setPermMode: (m: string) => void
  setModel: (m: string) => void
  sendChat: (msg: string) => Promise<string | undefined>
  interruptRun: () => Promise<void>
  decidePermission: (id: string, decision: "allow" | "deny") => Promise<void>
  answerQuestion: (picks: string[], note?: string) => Promise<void>
  decidePlan: (decision: "approve" | "deny", feedback?: string) => Promise<void>
  clearPendingDraft: () => void
  forkFromMessage: (uuid: string) => Promise<void>
  revertToMessage: (uuid: string, mode?: RestoreMode) => Promise<void>
  removeQueued: (i: number) => Promise<void>
  steerMessage: (msg: string) => Promise<string | undefined>
  addStash: (text: string) => void
  removeStash: (i: number) => void
}

export const createChatSlice: Slice<ChatSlice> = (set, get, rt) => {
  const { pollTick, watchChat, agentPreflight } = rt
  return {
    chatRunning: false,
    chatStatus: null,
    queue: [],
    pendingApprovals: [],
    stash: JSON.parse(localStorage.getItem("stash") || "[]") as string[],
    permMode: localStorage.getItem(PERM_MODE_KEY) || DEFAULT_PERM_MODE,
    model: localStorage.getItem("model") || "",
    pendingDraft: null,
    setPermMode: (m) => { localStorage.setItem(PERM_MODE_KEY, m); set({ permMode: m }) },
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
    // Answer a parked AskUserQuestion. This must hit the dedicated endpoint (which
    // unblocks the waiting call or resumes the session), NOT sendChat — a normal
    // chat message just gets QUEUED behind the still-blocked run, which is exactly
    // the "it adds to the queue instead of answering" bug.
    answerQuestion: async (picks, note = "") => {
      const { currentSessionPath, permMode, model } = get()
      if (!currentSessionPath) return
      set({ chatRunning: true, chatStatus: null })
      try {
        const res = await api.chatQuestionAnswer({
          session: currentSessionPath,
          picks,
          note,
          mode: permMode,
          model,
        })
        const d = await res.json().catch(() => ({}))
        if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`)
        await pollTick()
        const sid = d.session || sessionIdOf(currentSessionPath)
        watchChat(sid)
      } catch (e: any) {
        set({ chatRunning: false, chatStatus: { kind: "error", text: "Failed to answer: " + (e?.message || e) } })
      }
    },
    // Approve / request changes on a live ExitPlanMode. Like answerQuestion this
    // must hit the dedicated endpoint: the run is BLOCKED on the decision, so a
    // normal chat message would only queue behind it. Approving continues the
    // same turn, hence chatRunning stays true and we re-watch rather than start.
    decidePlan: async (decision, feedback) => {
      const { currentSessionPath } = get()
      if (!currentSessionPath) return
      set({ chatRunning: true, chatStatus: null })
      try {
        const res = await api.chatPlanDecide({ session: currentSessionPath, decision, feedback: feedback || "" })
        const d = await res.json().catch(() => ({}))
        if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`)
        await pollTick()
        watchChat(d.session || sessionIdOf(currentSessionPath))
      } catch (e: any) {
        set({ chatRunning: false, chatStatus: { kind: "error", text: "Failed to decide: " + (e?.message || e) } })
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
      const { currentSessionPath, queue } = get()
      const removed = queue[i]
      await api.chatQueueRemove({ path: currentSessionPath, index: i }).catch(() => {})
      // Pulling a message off the queue returns its text to the composer (not a
      // silent discard) — mirrors mobile's unqueue, so an un-queue is editable,
      // not lost. The composer prepends it, preserving any in-progress draft.
      set({ queue: queue.filter((_, idx) => idx !== i), pendingDraft: removed ?? null })
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
  }
}
