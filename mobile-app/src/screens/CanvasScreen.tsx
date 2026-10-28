/**
 * CanvasScreen — the project's shared canvas (Excalidraw), the same live board
 * the web app shows: people and agents draw on it together, and what an agent
 * shows with canvas_show lands on it as a doc tile. The web app renders it at
 * /?canvasSession=<sid>&embed=1; this screen is a WebView of that page.
 *
 * Auth: the page's fetches and live socket authenticate by the viewer_session
 * cookie, so the app's token is set as that cookie before the page loads.
 * The relay is end-to-end encrypted between this app and the server, so a
 * WebView cannot ride it: the canvas needs the server's direct address.
 */
import React, { useEffect, useState } from "react"
import { Linking, Pressable, Text, View } from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import { WebView } from "react-native-webview"
import type { RootStackParamList } from "../../App"
import { directUrl } from "../lib/servers"
import { activeServer, token } from "../state/config"
import { userError } from "../lib/errors"
import { useTheme } from "../lib/useTheme"
import { isDarkBg } from "../components/Markdown"

type Props = NativeStackScreenProps<RootStackParamList, "Canvas">

export default function CanvasScreen({ navigation, route }: Props) {
  const t = useTheme()
  const { session, title } = route.params
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const base = directUrl(activeServer()).replace(/\/+$/, "")
  const dark = isDarkBg(t.bg)

  // Drawing from the left edge must not swipe the screen away.
  useEffect(() => {
    navigation.setOptions({ title: `Canvas · ${title}`, gestureEnabled: false })
  }, [navigation, title])

  const uri = `${base}/?canvasSession=${encodeURIComponent(session)}&embed=1&theme=${dark ? "dark" : "light"}`
  // Read on every render, so Try again picks up a refreshed token.
  const setCookie = `document.cookie = "viewer_session=" + ${JSON.stringify(token())} + "; path=/; SameSite=Strict"; true;`

  if (!base) {
    return (
      <View style={[{ flex: 1,  padding: 24, justifyContent: "center", backgroundColor: t.bg }]}>
        <Text style={{ color: t.text, fontSize: 16, textAlign: "center" }}>
          The canvas needs the server's direct address (same network or Tailscale). This server is reachable
          only through the Harman relay, which the canvas cannot use yet.
        </Text>
      </View>
    )
  }

  if (error) {
    return (
      <View style={[{ flex: 1,  padding: 24, justifyContent: "center", alignItems: "center", gap: 16, backgroundColor: t.bg }]}>
        <Text testID="canvas-error" style={{ color: t.text, fontSize: 16, textAlign: "center" }}>{error}</Text>
        <Pressable testID="canvas-retry" accessibilityRole="button" onPress={() => { setError(""); setAttempt((n) => n + 1) }}>
          <Text style={{ color: t.accent, fontSize: 16, fontWeight: "600" }}>Try again</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <WebView
      key={attempt}
      testID="canvas-webview"
      source={{ uri }}
      style={{ flex: 1, backgroundColor: t.bg }}
      injectedJavaScriptBeforeContentLoaded={setCookie}
      sharedCookiesEnabled={false}
      originWhitelist={[base]}
      // The canvas stays on its own page; any link on it opens outside the app.
      onShouldStartLoadWithRequest={(req) => {
        if (req.url.startsWith(base)) return true
        void Linking.openURL(req.url)
        return false
      }}
      onError={(e) => setError(userError(new Error(e.nativeEvent.description), "the canvas"))}
      onHttpError={(e) => setError(userError(new Error(`HTTP ${e.nativeEvent.statusCode}`), "the canvas"))}
    />
  )
}
