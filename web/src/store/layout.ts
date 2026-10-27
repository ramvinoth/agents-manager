/** Panels, tabs and docking — pure UI state persisted to localStorage. */
import type { Slice } from "./types"

export interface LayoutSlice {
  lhsTab: string
  /** The focused project on the Projects tab, per host; the Files tab roots there. */
  projectDirs: Record<string, string>
  /** The projects expanded in the Projects tree, per host. */
  openProjects: Record<string, string[]>
  rhsTab: string
  /** The wide-screen left rail (Projects, Files, Settings, Stats); open by default. */
  lhsOpen: boolean
  /** The wide-screen Skills/MCP/Plugins panel; closed until the user opens it. */
  rhsOpen: boolean
  panel: "terminal" | "browser" | null
  // When set, the terminal panel launches this command in a dedicated persistent
  // session (key) instead of the general host shell — used by "Continue interactively".
  termInit: { key: string; cmd: string } | null
  fsOpen: boolean
  fsPick: ((dir: string) => void) | null
  dockSplit: number
  panelFloating: boolean
  floatRect: { x: number; y: number; w: number; h: number }
  setLhsTab: (t: string) => void
  /** Focus (or, with null, unfocus) a project on the current host. */
  setProjectDir: (dir: string | null) => void
  /** Expand or collapse a project in the tree; `open` omitted toggles it. */
  setProjectOpen: (dir: string, open?: boolean) => void
  setRhsTab: (t: string) => void
  /** Show the right panel on tab `t` (opens it if shut; never toggles it shut). */
  openRhs: (t: string) => void
  toggleRhs: () => void
  toggleLhs: () => void
  openPanel: (k: "terminal" | "browser") => void
  closePanel: () => void
  continueInteractively: (cmd: string, key: string) => void
  openFs: () => void
  pickDir: (cb: (dir: string) => void) => void
  closeFs: () => void
  setDockSplit: (n: number) => void
  toggleFloating: () => void
  setFloatRect: (r: { x: number; y: number; w: number; h: number }) => void
}

// One focused project per host, persisted so a page refresh keeps the Files root.
const PROJECT_DIR = "projectDir:"
function loadProjectDirs(): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    const v = k?.startsWith(PROJECT_DIR) ? localStorage.getItem(k) : null
    if (k && v) out[k.slice(PROJECT_DIR.length)] = v
  }
  return out
}

// The tree's expanded projects, all hosts in one key.
const OPEN_PROJECTS = "openProjects"
function loadOpenProjects(): Record<string, string[]> {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_PROJECTS) || "{}")
    return v && typeof v === "object" && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

export const createLayoutSlice: Slice<LayoutSlice> = (set, get) => {
  return {
    lhsTab: localStorage.getItem("lhsTab") || "projects",
    projectDirs: loadProjectDirs(),
    openProjects: loadOpenProjects(),
    rhsTab: localStorage.getItem("rhsTab") || "skills",
    rhsOpen: localStorage.getItem("rhsOpen") === "1",
    lhsOpen: localStorage.getItem("lhsOpen") !== "0",
    panel: (localStorage.getItem("panel") as "terminal" | "browser" | null) || null,
    termInit: JSON.parse(localStorage.getItem("termInit") || "null"),
    fsOpen: false,
    fsPick: null,
    dockSplit: Math.min(0.85, Math.max(0.15, parseFloat(localStorage.getItem("dockSplit") || "0.5") || 0.5)),
    panelFloating: localStorage.getItem("panelFloating") === "1",
    floatRect: (() => {
      try {
        const r = JSON.parse(localStorage.getItem("floatRect") || "null")
        if (r && typeof r.x === "number") return r
      } catch {
        /* fall through */
      }
      return { x: 140, y: 96, w: 760, h: 480 }
    })(),
    setLhsTab: (t) => { localStorage.setItem("lhsTab", t); set({ lhsTab: t }) },
    setProjectDir: (dir) => {
      const host = get().currentHost
      const next = { ...get().projectDirs }
      if (dir) {
        localStorage.setItem(PROJECT_DIR + host, dir)
        next[host] = dir
      } else {
        localStorage.removeItem(PROJECT_DIR + host)
        delete next[host]
      }
      set({ projectDirs: next })
    },
    setProjectOpen: (dir, open) => {
      const host = get().currentHost
      const cur = get().openProjects[host] ?? []
      const want = open ?? !cur.includes(dir)
      if (want === cur.includes(dir)) return
      const next = { ...get().openProjects, [host]: want ? [...cur, dir] : cur.filter((d) => d !== dir) }
      localStorage.setItem(OPEN_PROJECTS, JSON.stringify(next))
      set({ openProjects: next })
    },
    setRhsTab: (t) => { localStorage.setItem("rhsTab", t); set({ rhsTab: t }) },
    openRhs: (t) => {
      localStorage.setItem("rhsTab", t)
      localStorage.setItem("rhsOpen", "1")
      set({ rhsTab: t, rhsOpen: true })
    },
    toggleRhs: () => {
      const v = !get().rhsOpen
      localStorage.setItem("rhsOpen", v ? "1" : "0")
      set({ rhsOpen: v })
    },
    toggleLhs: () => {
      const v = !get().lhsOpen
      localStorage.setItem("lhsOpen", v ? "1" : "0")
      set({ lhsOpen: v })
    },
    openPanel: (k) => {
      // Persist so a refresh restores the open panel; opening the general
      // terminal clears any interactive-session target (back to the host shell).
      localStorage.setItem("panel", k)
      if (k === "terminal") {
        localStorage.removeItem("termInit")
        set({ panel: k, termInit: null })
      } else {
        set({ panel: k })
      }
    },
    closePanel: () => {
      localStorage.removeItem("panel")
      set({ panel: null })
    },
    continueInteractively: (cmd, key) => {
      localStorage.setItem("panel", "terminal")
      localStorage.setItem("termInit", JSON.stringify({ key, cmd }))
      set({ panel: "terminal", termInit: { key, cmd } })
    },
    openFs: () => set({ fsOpen: true, fsPick: null }),
    pickDir: (cb) => set({ fsOpen: true, fsPick: cb }),
    closeFs: () => set({ fsOpen: false, fsPick: null }),
    setDockSplit: (n) => {
      const v = Math.min(0.85, Math.max(0.15, n))
      localStorage.setItem("dockSplit", String(v))
      set({ dockSplit: v })
    },
    toggleFloating: () => {
      const v = !get().panelFloating
      localStorage.setItem("panelFloating", v ? "1" : "0")
      set({ panelFloating: v })
    },
    setFloatRect: (r) => {
      localStorage.setItem("floatRect", JSON.stringify(r))
      set({ floatRect: r })
    },
  }
}
