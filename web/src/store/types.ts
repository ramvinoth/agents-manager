/** Shared store types: the composed state and the slice-creator signature. */
import type { StoreApi } from "zustand"
import type { AgentsSlice } from "./agents"
import type { AuthSlice } from "./auth"
import type { ChatSlice } from "./chat"
import type { DetailsSlice } from "./details"
import type { LayoutSlice } from "./layout"
import type { OrchestrationSlice } from "./orchestration"
import type { Runtime } from "./runtime"
import type { SessionSlice } from "./session"

export type AppState = AuthSlice & AgentsSlice & SessionSlice & ChatSlice & DetailsSlice & OrchestrationSlice & LayoutSlice
export type SetState = StoreApi<AppState>["setState"]
export type GetState = StoreApi<AppState>["getState"]

/** A slice reads and writes the WHOLE store (actions cross areas, e.g. loadSession
 *  kicks off capabilities and loops) and shares one run engine (`rt`). */
export type Slice<T> = (set: SetState, get: GetState, rt: Runtime) => T

export type RestoreMode = "conversation" | "code" | "code+conversation"

export interface AuthStatus {
  loggedIn?: boolean
  method?: string
  subscriptionType?: string
}
export interface ChatStatus {
  kind: "running" | "done" | "error"
  text: string
}
export interface PermApproval {
  id: string
  tool_name: string
  input: unknown
}

export interface ProjectDir {
  cwd: string
  [k: string]: unknown
}
export interface NewSessionOpts {
  cwd: string
  message: string
  title?: string
  systemPrompt?: string
  goal?: string
}

