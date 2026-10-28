/** The side pane beside the chat: this session's open decisions ("Needs you").
 *  What an agent shows lives on the project canvas as doc tiles, not here.
 *  On demand: closed until something needs the owner; if the owner closed it, a
 *  new decision raises a badge on the header button instead of popping it open. */
import { api } from "../lib/api"
import type { OpenDecision } from "../lib/types"
import type { Slice } from "./types"
import { sessionIdOf } from "./helpers"

export interface CanvasSlice {
  canvasOpen: boolean
  /** Decisions that landed while the owner had the pane closed. */
  canvasUnseen: number
  /** The owner closed the pane for this session: stop auto-opening it. */
  canvasClosedByOwner: boolean
  /** This session's open decisions (questions, plans, approvals, cards waiting on the owner). */
  canvasNeeds: OpenDecision[]
  /** Refresh this session's needs; open the pane when new ones land (or badge
   *  the header button if the owner closed it). */
  loadNeeds: () => Promise<void>
  showNeeds: () => void
  closeCanvas: () => void
  /** A session switch: forget the old session's needs and the owner's close. */
  resetCanvases: () => void
}

export const createCanvasSlice: Slice<CanvasSlice> = (set, get) => ({
  canvasOpen: false,
  canvasUnseen: 0,
  canvasClosedByOwner: false,
  canvasNeeds: [],
  loadNeeds: async () => {
    const path = get().currentSessionPath
    const sid = sessionIdOf(path)
    if (!sid) return
    // A missing route (404, server not restarted yet) or a blip leaves the list as it was.
    const res = await api.openDecisions().catch(() => null)
    if (!res || get().currentSessionPath !== path) return
    const needs = res.decisions.filter((d) => d.session === sid)
    const key = (d: OpenDecision) => `${d.kind}:${d.tool_use_id || d.id || d.card || ""}`
    const known = new Set(get().canvasNeeds.map(key))
    const fresh = needs.filter((d) => !known.has(key(d))).length
    const patch: Partial<CanvasSlice> = { canvasNeeds: needs }
    if (!needs.length) Object.assign(patch, { canvasOpen: false, canvasUnseen: 0 })
    else if (fresh) {
      if (get().canvasClosedByOwner) patch.canvasUnseen = get().canvasUnseen + fresh
      else patch.canvasOpen = true
    }
    set(patch)
  },
  showNeeds: () => set({ canvasOpen: true, canvasUnseen: 0, canvasClosedByOwner: false }),
  closeCanvas: () => set({ canvasOpen: false, canvasClosedByOwner: true }),
  resetCanvases: () => set({ canvasOpen: false, canvasUnseen: 0, canvasClosedByOwner: false, canvasNeeds: [] }),
})
