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

export interface HarmanWebViewProps extends ViewProps {
  /** Names this view for `post`. */
  viewId: string
  /** Injected at document start, main frame only. */
  script: string
  /** A harman://app URL; loaded once, and again when it changes. */
  url: string
  onRequest(e: NativeEvent<PageRequestEvent>): void
  onMessage(e: NativeEvent<{ data: string }>): void
  onOpenExternal(e: NativeEvent<{ url: string }>): void
  onLoadError(e: NativeEvent<{ message: string }>): void
}

interface HarmanWebViewNative {
  respond(id: string, status: number, headers: Record<string, string>, body: Uint8Array): Promise<void>
  fail(id: string, message: string): Promise<void>
  post(viewId: string, json: string): Promise<void>
}

// Autolinked local Expo module (modules/harman-webview), iOS only. Where it is
// missing (an older build, Android) callers check `isAvailable`.
let native: HarmanWebViewNative | null = null
let view: ComponentType<HarmanWebViewProps> | null = null
try {
  native = requireNativeModule<HarmanWebViewNative>("HarmanWebView")
  view = requireNativeViewManager<HarmanWebViewProps>("HarmanWebView")
} catch {
  native = null
  view = null
}

export const HarmanWebView = {
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
