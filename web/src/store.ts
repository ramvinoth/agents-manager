/**
 * The app's one Zustand store, composed from per-area slices (src/store/*).
 * Every slice sees the whole state, so `useStore(s => s.anything)` works as before.
 */
import { create } from "zustand"
import { createAgentsSlice } from "./store/agents"
import { createAuthSlice } from "./store/auth"
import { createChatSlice } from "./store/chat"
import { createDetailsSlice } from "./store/details"
import { createLayoutSlice } from "./store/layout"
import { createOrchestrationSlice } from "./store/orchestration"
import { createRuntime } from "./store/runtime"
import { createSessionSlice } from "./store/session"
import type { AppState } from "./store/types"

export { sessionIdOf } from "./store/helpers"
export type { RestoreMode } from "./store/types"

export const useStore = create<AppState>((set, get) => {
  const rt = createRuntime(set, get)
  return {
    ...createAuthSlice(set, get, rt),
    ...createAgentsSlice(set, get, rt),
    ...createSessionSlice(set, get, rt),
    ...createChatSlice(set, get, rt),
    ...createDetailsSlice(set, get, rt),
    ...createOrchestrationSlice(set, get, rt),
    ...createLayoutSlice(set, get, rt),
  }
})

/** The label of the currently-selected agent, for generic UI copy. */
export const useAgentLabel = () =>
  useStore((s) => s.agents.find((a) => a.id === s.currentAgent)?.label || "Agent")
