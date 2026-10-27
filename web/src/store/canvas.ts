/** Canvas: the visual pane an agent opens beside the chat (lib/canvas has the logic).
 *  On demand: closed until the agent shows something; if the owner closed it, a
 *  new show raises a badge on the header button instead of popping it open again. */
import { api } from "../lib/api"
import type { CanvasMeta } from "../lib/canvas"
import type { Slice } from "./types"
import { sessionIdOf } from "./helpers"

export interface CanvasSlice {
  /** The current session's canvases, newest first. */
  canvases: CanvasMeta[]
  canvasActive: string | null
  canvasOpen: boolean
  /** Shows that landed while the owner had the pane closed. */
  canvasUnseen: number
  /** The owner closed the pane for this session: stop auto-opening it. */
  canvasClosedByOwner: boolean
  /** Reload the list for the current session (null-safe across session switches). */
  loadCanvases: () => Promise<void>
  /** A new show landed in the transcript: refresh, focus it, open or badge. */
  canvasShown: (title: string) => Promise<void>
  openCanvas: (title?: string) => void
  closeCanvas: () => void
  deleteCanvas: (title: string) => Promise<void>
  /** A session switch: forget the old session's canvases and the owner's close. */
  resetCanvases: () => void
}

export const createCanvasSlice: Slice<CanvasSlice> = (set, get) => ({
  canvases: [],
  canvasActive: null,
  canvasOpen: false,
  canvasUnseen: 0,
  canvasClosedByOwner: false,
  loadCanvases: async () => {
    const path = get().currentSessionPath
    const sid = sessionIdOf(path)
    if (!sid) return
    const { canvases } = await api.canvasList(sid).catch(() => ({ canvases: [] as CanvasMeta[] }))
    if (get().currentSessionPath !== path) return
    const active = get().canvasActive
    set({
      canvases,
      canvasActive: active && canvases.some((c) => c.title === active) ? active : canvases[0]?.title ?? null,
      canvasOpen: get().canvasOpen && canvases.length > 0,
    })
  },
  canvasShown: async (title) => {
    await get().loadCanvases()
    if (!get().canvases.some((c) => c.title === title)) return
    if (get().canvasClosedByOwner) set({ canvasActive: title, canvasUnseen: get().canvasUnseen + 1 })
    else set({ canvasActive: title, canvasOpen: true })
  },
  openCanvas: (title) =>
    set({ canvasOpen: true, canvasUnseen: 0, canvasClosedByOwner: false, ...(title ? { canvasActive: title } : {}) }),
  closeCanvas: () => set({ canvasOpen: false, canvasClosedByOwner: true }),
  deleteCanvas: async (title) => {
    const sid = sessionIdOf(get().currentSessionPath)
    if (!sid) return
    await api.canvasDelete(sid, title)
    if (get().canvasActive === title) set({ canvasActive: null })
    await get().loadCanvases()
  },
  resetCanvases: () =>
    set({ canvases: [], canvasActive: null, canvasOpen: false, canvasUnseen: 0, canvasClosedByOwner: false }),
})
