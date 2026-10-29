/**
 * CanvasScreen — the project's shared canvas (Excalidraw), the same live board
 * the web app shows: people and agents draw on it together, and what an agent
 * shows with canvas_show lands on it as a doc tile. The web app renders it at
 * /?canvasSession=<sid>&embed=1; this screen hosts that page in HarmanWebView.
 *
 * The page loads from harman://app, and every request it makes (and its live
 * socket, through the injected shim) is answered by the app's own transport —
 * direct or the end-to-end encrypted relay, with the app's Bearer token — so
 * the canvas works wherever the rest of the app does. See lib/webBridge.ts.
 */
import React, { useEffect, useMemo, useState } from "react"
import { Linking, Pressable, Text, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { HarmanWebView } from "../../modules/harman-webview/src"
import { serverExchange, serverSocket } from "../api/transport"
import { fromBase64 } from "../lib/bytes"
import { APP_ORIGIN, AssetCache, SocketBridge, answer, externalUrl, parseOpenRef, parsePageMessage, wsShimScript, type OpenRef } from "../lib/webBridge"
import { activeServerId } from "../state/config"
import { userError } from "../lib/errors"
import { useTheme } from "../lib/useTheme"
import { isDarkBg } from "../components/Markdown"

type Props = NativeStackScreenProps<RootStackParamList, "Canvas">

// The page's hashed bundles, shared across visits so reopening is instant.
const assets = new AssetCache(32 * 1024 * 1024)
const shim = wsShimScript()

export default function CanvasScreen({ navigation, route }: Props) {
  const t = useTheme()
  const { session, title } = route.params
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const dark = isDarkBg(t.bg)
  const viewId = `canvas-${session}-${attempt}`

  // Drawing from the left edge must not swipe the screen away.
  useEffect(() => {
    navigation.setOptions({ title: `Canvas · ${title}`, gestureEnabled: false })
  }, [navigation, title])

  // One socket bridge per attempt; its sockets close with the page.
  const bridge = useMemo(
    () => new SocketBridge(serverSocket, (ev) => void HarmanWebView.post(viewId, JSON.stringify(ev))),
    [viewId]
  )
  useEffect(() => () => bridge.closeAll(), [bridge])

  // A tile's link opens the native screen it points at. The phone has no
  // Sift reader and the Map can't jump to one file yet, so code opens the Map.
  const openRef = (ref: OpenRef) => {
    if (ref.kind === "card") navigation.navigate("CardDetail", { id: ref.id })
    else if (ref.kind === "note") navigation.navigate("NoteEditor", { id: ref.id })
    else if (ref.kind === "inbox") navigation.navigate("Inbox", { session, title })
    else if (ref.kind === "code") navigation.navigate("Map", { session, title })
  }

  const View_ = HarmanWebView.View
  if (!View_) {
    return (
      <View style={{ flex: 1, padding: 24, justifyContent: "center", backgroundColor: t.bg }}>
        <Text testID="canvas-error" style={{ color: t.text, fontSize: 16, textAlign: "center" }}>
          This version of the app can't show the canvas. Update the app to use it.
        </Text>
      </View>
    )
  }

  if (error) {
    return (
      <View style={{ flex: 1, padding: 24, justifyContent: "center", alignItems: "center", gap: 16, backgroundColor: t.bg }}>
        <Text testID="canvas-error" style={{ color: t.text, fontSize: 16, textAlign: "center" }}>{error}</Text>
        <Pressable testID="canvas-retry" accessibilityRole="button" onPress={() => { setError(""); setAttempt((n) => n + 1) }}>
          <Text style={{ color: t.accent, fontSize: 16, fontWeight: "600" }}>Try again</Text>
        </Pressable>
      </View>
    )
  }

  const url = `${APP_ORIGIN}/?canvasSession=${encodeURIComponent(session)}&embed=1&theme=${dark ? "dark" : "light"}`
  return (
    <View_
      key={viewId}
      testID="canvas-webview"
      viewId={viewId}
      script={shim}
      url={url}
      style={{ flex: 1, backgroundColor: t.bg }}
      onRequest={({ nativeEvent: r }) => {
        const body = r.body ? fromBase64(r.body) : undefined
        answer({ method: r.method, path: r.path, headers: r.headers, body }, serverExchange, assets, activeServerId()).then(
          (res) => HarmanWebView.respond(r.id, res.status, res.headers, res.body),
          (e) => HarmanWebView.fail(r.id, userError(e, "the canvas"))
        )
      }}
      onMessage={({ nativeEvent }) => {
        const ref = parseOpenRef(nativeEvent.data)
        if (ref) return openRef(ref)
        const msg = parsePageMessage(nativeEvent.data)
        if (msg) bridge.handle(msg)
      }}
      onOpenExternal={({ nativeEvent }) => {
        const url = externalUrl(nativeEvent.url)
        if (url) Linking.openURL(url).catch(() => {})
      }}
      onLoadError={({ nativeEvent }) => setError(userError(new Error(nativeEvent.message), "the canvas"))}
    />
  )
}
