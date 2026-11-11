/**
 * The one live voice call, as plain state. The call itself (listen loop, audio,
 * CallKit) runs in <CallHost>, mounted once above the navigator, so it outlives
 * any screen: minimizing the Call screen must not hang up. This store is only
 * "is there a call, with whom, and which screen is showing".
 */
export interface CallState {
  active: boolean
  label: string
  path: string | undefined
  /** Name of the focused route, so the in-call pill hides on the Call screen itself. */
  route: string | undefined
}

type Listener = () => void

let state: CallState = { active: false, label: "", path: undefined, route: undefined }
const listeners = new Set<Listener>()

function set(next: CallState) {
  state = next
  listeners.forEach((l) => l())
}

export const callSession = {
  get: (): CallState => state,
  subscribe(l: Listener): () => void {
    listeners.add(l)
    return () => { listeners.delete(l) }
  },
  /** Begin a call; a second start while one is live keeps the live one. */
  start(label: string, path: string | undefined): boolean {
    if (state.active) return false
    set({ ...state, active: true, label, path })
    return true
  },
  end() {
    if (state.active) set({ ...state, active: false, label: "", path: undefined })
  },
  setRoute(route: string | undefined) {
    if (route !== state.route) set({ ...state, route })
  },
}

/** The pill shows during a call on every screen except the call screen. */
export function showCallPill(s: CallState): boolean {
  return s.active && s.route !== "Call"
}

/** mm:ss elapsed. */
export function fmtElapsed(sec: number): string {
  return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, "0")}`
}
