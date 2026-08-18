import React, { useEffect, useState } from "react"
import { ActivityIndicator, useColorScheme, View } from "react-native"
import { GestureHandlerRootView } from "react-native-gesture-handler"
import { StatusBar } from "expo-status-bar"
import { createNavigationContainerRef, DarkTheme, DefaultTheme, NavigationContainer, type Theme as NavTheme } from "@react-navigation/native"
import { createNativeStackNavigator } from "@react-navigation/native-stack"
import { effectiveScheme, themeFor } from "./src/lib/theme"
import { useThemePref } from "./src/lib/useTheme"
// Required by useSafeAreaInsets (the composer pads for the home indicator).
// React Navigation 6 does NOT provide this automatically.
import { SafeAreaProvider } from "react-native-safe-area-context"
import type { Host as HostConfig } from "./src/api/client"
import { api } from "./src/api/client"
import { loadConfig, serverUrl, token } from "./src/state/config"
import { registerForPush, onNotificationTap } from "./src/lib/notify"
import ServerScreen from "./src/screens/ServerScreen"
import LoginScreen from "./src/screens/LoginScreen"
import HomeTabs from "./src/screens/HomeTabs"
import NewChatScreen from "./src/screens/NewChatScreen"
import ThreadScreen from "./src/screens/ThreadScreen"
import VoiceScreen from "./src/screens/VoiceScreen"
import CallScreen from "./src/screens/CallScreen"
import SessionProfileScreen from "./src/screens/SessionProfileScreen"
import CapabilitiesScreen from "./src/screens/CapabilitiesScreen"
import ProvidersScreen from "./src/screens/ProvidersScreen"
import KanbanScreen from "./src/screens/KanbanScreen"
import OrgScreen from "./src/screens/OrgScreen"
import HostEditScreen from "./src/screens/HostEditScreen"
import TerminalScreen from "./src/screens/TerminalScreen"

export type RootStackParamList = {
  Server: { mode?: "initial" | "add" } | undefined
  Login: undefined
  Home: undefined
  NewChat: undefined
  Thread: { host: string; label: string; path?: string; jumpTo?: string }
  Voice: { host: string; label: string; path?: string }
  Call: { host: string; label: string; path?: string }
  SessionProfile: { host: string; label: string; path?: string; sessionId: string }
  Capabilities: undefined
  Providers: undefined
  Kanban: { session?: string; project?: number; assignee?: number; title?: string } | undefined
  Org: undefined
  HostEdit: { host?: HostConfig } | undefined
  Terminal: { host: string; label: string }
}

const Stack = createNativeStackNavigator<RootStackParamList>()

// Ref to the navigation tree so notification taps (which fire OUTSIDE React,
// from the native module) can navigate without a screen in scope.
export const navigationRef = createNavigationContainerRef<RootStackParamList>()

// A tap can fire BEFORE the navigation tree mounts — this is the norm on a cold
// start, where getLastNotificationResponseAsync resolves while <NavigationContainer>
// is still initializing. So we buffer the most-recent target and flush it once the
// tree is ready (see flushPendingNav, called from NavigationContainer.onReady and
// after a warm tap). Bailing on !isReady() was why the tap only foregrounded the app.
let pendingNav: Record<string, unknown> | null = null

// Resolve a push payload {session, host} to its session PATH and open the Thread.
// The payload carries the session id, but Thread navigates by `path` (unique;
// id is not), so we look the session up on its host. Best-effort — a stale id or
// offline host just no-ops rather than throwing.
async function navToSession(data: Record<string, unknown>): Promise<void> {
  const session = typeof data.session === "string" ? data.session : ""
  const host = typeof data.host === "string" ? data.host : "local"
  if (!session) return
  try {
    const sessions = await api.sessions(host)
    const match = sessions.find((s) => s.id === session)
    if (!match) return
    const label = match.title || match.id.slice(0, 8)
    navigationRef.navigate("Thread", { host, label, path: match.path })
  } catch {
    /* tap routing is best-effort */
  }
}

// Handle a tap: if the tree is ready, navigate now; otherwise stash it so
// flushPendingNav can complete the jump once the container mounts.
function openFromNotification(data: Record<string, unknown>): void {
  const session = typeof data.session === "string" ? data.session : ""
  if (!session) return
  if (navigationRef.isReady()) void navToSession(data)
  else pendingNav = data
}

// Drain any tap that arrived before navigation was ready (cold start).
function flushPendingNav(): void {
  const data = pendingNav
  pendingNav = null
  if (data && navigationRef.isReady()) void navToSession(data)
}

export default function App() {
  const [ready, setReady] = useState(false)
  const [initial, setInitial] = useState<keyof RootStackParamList>("Server")
  // Respect the user's theme PREFERENCE (system/light/dark), not just the raw OS
  // scheme — otherwise forcing Light while the OS is Dark leaves the navigation
  // header/card dark while every useTheme() screen goes light.
  const pref = useThemePref()
  const os = useColorScheme()
  const scheme = effectiveScheme(pref, os)
  const t = themeFor(scheme)

  // Theme the whole navigation chrome (header + card) so the native header
  // matches the chat instead of rendering a white bar in dark mode.
  const navBase = scheme === "dark" ? DarkTheme : DefaultTheme
  const navTheme: NavTheme = {
    ...navBase,
    colors: {
      ...navBase.colors,
      primary: t.accent,
      background: t.bg,
      card: t.surface,
      text: t.text,
      border: t.border,
    },
  }

  useEffect(() => {
    ;(async () => {
      try {
        await loadConfig()
        if (!serverUrl()) setInitial("Server")
        else if (!token()) setInitial("Login")
        else {
          setInitial("Home")
          // Logged in: register this device for background push so the server
          // can notify us when a run finishes / needs approval, even when the
          // app is closed. Best-effort — never blocks or breaks startup.
          registerForPush((tok) => api.pushRegister(tok)).catch(() => {})
        }
      } catch {
        // Keychain/config unavailable — never leave the app stuck on the
        // splash spinner; fall back to the Server screen.
        setInitial("Server")
      } finally {
        setReady(true)
      }
    })()
  }, [])

  // Route notification taps to the chat they belong to (foreground/background AND
  // cold start). Set up once; teardown on unmount.
  useEffect(() => onNotificationTap((data) => openFromNotification(data)), [])

  if (!ready) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator />
      </View>
    )
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <NavigationContainer theme={navTheme} ref={navigationRef} onReady={flushPendingNav}>
          <StatusBar style={scheme === "dark" ? "light" : "dark"} />
          <Stack.Navigator
            initialRouteName={initial}
            screenOptions={{
              headerStyle: { backgroundColor: t.surface },
              headerTitleStyle: { color: t.text },
              headerTintColor: t.accent,
              contentStyle: { backgroundColor: t.bg },
            }}
          >
            <Stack.Screen name="Server" component={ServerScreen} options={{ title: "Connect server" }} />
            <Stack.Screen name="Login" component={LoginScreen} options={{ title: "Sign in" }} />
            <Stack.Screen name="Home" component={HomeTabs} options={{ title: "Chats" }} />
            <Stack.Screen name="NewChat" component={NewChatScreen} options={{ title: "New chat" }} />
            <Stack.Screen name="Thread" component={ThreadScreen} options={({ route }) => ({ title: route.params.label })} />
            <Stack.Screen name="Voice" component={VoiceScreen} options={({ route }) => ({ title: `Voice — ${route.params.label}` })} />
            <Stack.Screen name="Call" component={CallScreen} options={{ headerShown: false, gestureEnabled: false }} />
            <Stack.Screen name="SessionProfile" component={SessionProfileScreen} options={{ title: "Session" }} />
            <Stack.Screen name="Capabilities" component={CapabilitiesScreen} options={{ title: "Skills & tools" }} />
            <Stack.Screen name="Providers" component={ProvidersScreen} options={{ title: "Model providers" }} />
            <Stack.Screen name="Kanban" component={KanbanScreen} options={{ title: "Board" }} />
            <Stack.Screen name="Org" component={OrgScreen} options={{ title: "Company" }} />
            <Stack.Screen name="HostEdit" component={HostEditScreen} options={{ title: "SSH host" }} />
            <Stack.Screen
              name="Terminal"
              component={TerminalScreen}
              options={({ route }) => ({ title: `Terminal — ${route.params.label}` })}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
