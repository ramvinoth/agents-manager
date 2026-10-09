/** Org-wide Harman state (automation switch, loop mode, system preamble), providers and loops. */
import { api } from "../lib/api"
import { isQueued } from "../lib/types"
import type { HarmanConfig, Loop, LoopControl, LoopMode, LoopSchedule, Provider } from "../lib/types"
import type { Slice } from "./types"
import { sessionIdOf } from "./helpers"

export interface OrchestrationSlice {
  /** Global custom-provider library (from /api/providers). Session-independent. */
  providers: Provider[]
  // Orchestration control state — ONE shared cache so the header/session-list
  // pinned Harman entry and the Profile tab never drift. null = not-yet-loaded
  // or server unreachable (rendered as "unknown", never guessed as off).
  harman: HarmanConfig | null
  loopControl: LoopControl | null
  /** True only when the server explicitly says automation is on — the pinned
   *  Harman entry and Harman controls are gated on this. Absence → off. */
  automationOn: boolean
  /** The global system-awareness preamble (prepended to every session's system
   *  prompt). null = not-yet-loaded or server unreachable; "" = explicitly empty
   *  (the feature is off). Loaded with the other orchestration state. */
  systemPreamble: string | null
  loops: Loop[]
  loadProviders: () => Promise<void>
  // Orchestration control — loaded once at boot, refreshed after any write so
  // all three surfaces (header, session-list pin, Profile tab) stay in sync.
  loadOrchestration: () => Promise<void>
  /** Flip the master automation switch. Turning ON is Red: a non-owner's request
   *  is queued (not applied), so this resolves to a status string for the caller
   *  to show ("" = applied cleanly). */
  setAutomation: (on: boolean) => Promise<string>
  /** Set the loop-firing mode. Green + manager-scoped: applied or refused (403),
   *  never queued. Resolves to "" on success or an error string. */
  setLoopMode: (mode: LoopMode) => Promise<string>
  /** Rewrite the global system preamble. Manager-scoped AND Red: a non-owner's
   *  request is queued (not applied), so this resolves to a status string for the
   *  caller to show ("" = applied cleanly). */
  setSystemPreamble: (text: string) => Promise<string>
  loadLoops: () => Promise<void>
  createLoop: (prompt: string, schedule: LoopSchedule, provider: string) => Promise<void>
  editLoop: (id: string, prompt: string, schedule: LoopSchedule, provider: string) => Promise<void>
  /** Pause (enabled=false) or resume (true) a loop. A paused loop stops firing;
   *  resuming leaves its nextRun untouched, so an overdue loop fires at most once. */
  toggleLoop: (id: string, enabled: boolean) => Promise<void>
  deleteLoop: (id: string) => Promise<void>
}

export const createOrchestrationSlice: Slice<OrchestrationSlice> = (set, get) => {
  return {
    providers: [],
    harman: null,
    loopControl: null,
    automationOn: false,
    systemPreamble: null,
    loops: [],
    // The global custom-provider library (session-independent). Loaded once at
    // boot and refreshed after CRUD in the ProvidersDialog.
    loadProviders: async () => {
      try {
        const r = await api.providers()
        set({ providers: r.providers || [] })
      } catch {
        /* ignore — keep last known list */
      }
    },
    // Orchestration control state (master switch + loop mode). One cache, loaded
    // at boot and after every write, so the header, the session-list pinned
    // Harman entry and the Profile tab all read the same server truth. On any
    // failure we clear to "unknown/off" — a switch that never reached the server
    // must not be shown as running unattended work.
    loadOrchestration: async () => {
      const [h, l, p] = await Promise.all([
        api.orgHarman().catch(() => null),
        api.orgLoopControl().catch(() => null),
        api.orgSystemPreamble().catch(() => null),
      ])
      set({
        harman: h, loopControl: l, automationOn: h?.automation_enabled === true,
        systemPreamble: p ? p.preamble : null,
      })
    },
    setAutomation: async (on) => {
      try {
        const res = await api.orgSetHarman({ automation_enabled: on })
        // Resuming is Red: a non-owner's request is QUEUED (200, nothing changed),
        // not applied. Report it so the unchanged switch reads as the gate working
        // rather than a bug, and re-sync from the server.
        if (isQueued(res)) {
          await get().loadOrchestration()
          return "Sent for approval — only the owner can turn automation on."
        }
        set({ harman: res, automationOn: res.automation_enabled === true })
        return ""
      } catch (e: any) {
        await get().loadOrchestration()
        return e?.message || "Couldn't change it."
      }
    },
    setLoopMode: async (mode) => {
      try {
        // Green + manager-scoped: the server returns the applied config directly;
        // a non-manager caller is refused (403) — postJSON resolves that body, so
        // guard on the shape rather than expecting a throw.
        const res: any = await api.orgSetLoopControl(mode)
        if (res?.denied) {
          await get().loadOrchestration()
          return res.reason || "Not allowed."
        }
        set({ loopControl: res })
        return ""
      } catch (e: any) {
        await get().loadOrchestration()
        return e?.message || "Couldn't change it."
      }
    },
    setSystemPreamble: async (text) => {
      try {
        const res = await api.orgSetSystemPreamble(text)
        // Manager + Red: a non-owner's write is QUEUED (nothing changed yet), not
        // applied. Report it so the unchanged text reads as the gate working, and
        // re-sync from the server (the applied value is authoritative).
        if (isQueued(res)) {
          await get().loadOrchestration()
          return "Sent for approval — only the owner can change the system preamble."
        }
        set({ systemPreamble: res.preamble })
        return ""
      } catch (e: any) {
        await get().loadOrchestration()
        return e?.message || "Couldn't change it."
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
    createLoop: async (prompt, schedule, provider) => {
      const { currentSessionPath } = get()
      if (!prompt.trim()) return
      const res = await api.loopsCreate({ session: currentSessionPath, prompt, ...schedule, provider })
      await res.json().catch(() => ({}))
      get().loadLoops()
    },
    editLoop: async (id, prompt, schedule, provider) => {
      if (!prompt.trim()) return
      const res = await api.loopsEdit({ id, prompt, ...schedule, provider })
      await res.json().catch(() => ({}))
      get().loadLoops()
    },
    toggleLoop: async (id, enabled) => {
      // Optimistic flip, then reload for the server's canonical row.
      set({ loops: get().loops.map((l) => (l.id === id ? { ...l, enabled } : l)) })
      await api.loopsEdit({ id, enabled }).catch(() => {})
      get().loadLoops()
    },
    deleteLoop: async (id) => {
      await api.loopsDelete(id).catch(() => {})
      set({ loops: get().loops.filter((l) => l.id !== id) })
    },
  }
}
