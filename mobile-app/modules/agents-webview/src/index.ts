import type { ComponentType } from "react"
import type { ViewProps } from "react-native"
import { requireNativeModule, requireNativeViewManager } from "expo-modules-core"

/** One request the page made, as the native scheme handler saw it.
 *  `path` is path + query; `body` is base64. */
export interface PageRequestEvent {
  id: string
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

type NativeEvent<T> = { nativeEvent: T }

export interface AgentsWebViewProps extends ViewProps {
  /** Names this view for `post`. */
  viewId: string
  /** Injected at document start, main frame only. */
  script: string
  /** A agents://app URL; loaded once, and again when it changes. */
  url: string
  onRequest(e: NativeEvent<PageRequestEvent>): void
  onMessage(e: NativeEvent<{ data: string }>): void
  onOpenExternal(e: NativeEvent<{ url: string }>): void
  onLoadError(e: NativeEvent<{ message: string }>): void
}

interface AgentsWebViewNative {
  respond(id: string, status: number, headers: Record<string, string>, body: Uint8Array): Promise<void>
  fail(id: string, message: string): Promise<void>
  post(viewId: string, json: string): Promise<void>
}

// Autolinked local Expo module (modules/agents-webview), iOS only. Where it is
// missing (an older build, Android) callers check `isAvailable`.
let native: AgentsWebViewNative | null = null
let view: ComponentType<AgentsWebViewProps> | null = null
try {
  native = requireNativeModule<AgentsWebViewNative>("AgentsWebView")
  view = requireNativeViewManager<AgentsWebViewProps>("AgentsWebView")
} catch {
  native = null
  view = null
}

export const AgentsWebView = {
  isAvailable: (): boolean => native != null && view != null,
  View: view,
  /** Answer page request `id`. */
  respond: (id: string, status: number, headers: Record<string, string>, body: Uint8Array) =>
    native?.respond(id, status, headers, body) ?? Promise.resolve(),
  /** Fail page request `id` (the page sees a network error). */
  fail: (id: string, message: string) => native?.fail(id, message) ?? Promise.resolve(),
  /** Deliver a socket event (JSON) to the page in view `viewId`. */
  post: (viewId: string, json: string) => native?.post(viewId, json) ?? Promise.resolve(),
}
