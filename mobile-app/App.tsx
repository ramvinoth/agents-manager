import React, { useEffect, useState, useSyncExternalStore } from "react"
import { CallProvider } from "./src/lib/CallProvider"
import { callSession, showCallPill } from "./src/lib/callSession"
import CallPill from "./src/components/CallPill"
import { ActivityIndicator, Linking, useColorScheme, View } from "react-native"
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
import { hasServer, loadConfig, token } from "./src/state/config"
import { recordScreen, startUsageReporting } from "./src/lib/usageReporter"
import { registerForPush, onNotificationTap, setForegroundSuppressor } from "./src/lib/notify"
import { notificationTarget, suppressForeground, threadInstanceId } from "./src/lib/notificationRoute"
import { pairFromLink } from "./src/state/signin"
import ServerScreen from "./src/screens/ServerScreen"
import LoginScreen from "./src/screens/LoginScreen"
import HomeTabs from "./src/screens/HomeTabs"
import NewChatScreen from "./src/screens/NewChatScreen"
import ThreadScreen from "./src/screens/ThreadScreen"
import CallScreen from "./src/screens/CallScreen"
import SessionProfileScreen from "./src/screens/SessionProfileScreen"
import CapabilitiesScreen from "./src/screens/CapabilitiesScreen"
import ProvidersScreen from "./src/screens/ProvidersScreen"
import UndoToast from "./src/components/UndoToast"
import ActionSheetHost from "./src/components/ActionSheetHost"
import IntegrationsScreen from "./src/screens/IntegrationsScreen"
import CalendarScreen from "./src/screens/CalendarScreen"
import KanbanScreen from "./src/screens/KanbanScreen"
import CardDetailScreen from "./src/screens/CardDetailScreen"
import NotesScreen from "./src/screens/NotesScreen"
import FilesScreen from "./src/screens/FilesScreen"
import AgentsScreen from "./src/screens/AgentsScreen"
import AgentEditScreen from "./src/screens/AgentEditScreen"
import AgentToolsScreen from "./src/screens/AgentToolsScreen"
import InboxScreen from "./src/screens/InboxScreen"
import NoteEditorScreen from "./src/screens/NoteEditorScreen"
import OrgScreen from "./src/screens/OrgScreen"
import AuditScreen from "./src/screens/AuditScreen"
import CanvasScreen from "./src/screens/CanvasScreen"
import AuditEntryScreen from "./src/screens/AuditEntryScreen"
import type { AuditEntry } from "./src/lib/audit"
import HostEditScreen from "./src/screens/HostEditScreen"
import type { StartingChat } from "./src/lib/session"
import TerminalScreen from "./src/screens/TerminalScreen"

export type RootStackParamList = {
  Server: { mode?: "initial" | "add" } | undefined
  Login: undefined
  // A decision push opens the deck on that item (HomeTabs consumes and clears these).
  Home: { decision?: string; ref?: string; session?: string } | undefined
  NewChat: { template?: import("./src/api/client").AgentTemplate; cwd?: string } | undefined
  // `starting`: a chat that was just started and whose transcript isn't written
  // yet — the thread opens at once and resolves it (see ThreadScreen).
  Thread: { host: string; label: string; path?: string; session?: string; jumpTo?: string; agent?: string; starting?: StartingChat }
  Call: { label: string; path?: string }
  SessionProfile: { host: string; label: string; path?: string; sessionId: string; agent?: string }
  Capabilities: { host?: string; cwd?: string; session?: string; agent?: string; title?: string } | undefined
  Providers: undefined
  Integrations: undefined
  Calendar: undefined
  Kanban: { session?: string; project?: number; assignee?: number; title?: string } | undefined
  CardDetail: { id: number }
  Notes: { session?: string; project?: number; title?: string; tag?: string } | undefined
  Canvas: { session: string; title: string }
  Files: undefined
  Agents: undefined
  /** Create (no template) or edit one of the caller's own agents. */
  AgentEdit: { template?: import("./src/api/client").AgentTemplate } | undefined
  AgentTools: { id: number; name: string; kind: "skill" | "mcp" }
  NoteEditor: { id: number }
  Inbox: { session?: string; host?: string; path?: string; title?: string } | undefined
  Org: undefined
  Audit: undefined
  AuditEntry: { entry: AuditEntry }
  HostEdit: { host?: HostConfig } | undefined
  Terminal: undefined
}

const Stack = createNativeStackNavigator<RootStackParamList>()

// Ref to the navigation tree so notification taps (which fire OUTSIDE React,
// from the native module) can navigate without a screen in scope.
/** Records the focused screen for analytics and tells the call pill which route is showing. */
function trackRoute() {
  const name = navigationRef.getCurrentRoute()?.name
  recordScreen(name)
  callSession.setRoute(name)
}

/** The in-call pill, tapping it returns to the live call screen. */
function CallPillHost() {
  const state = useSyncExternalStore(callSession.subscribe, callSession.get)
  if (!showCallPill(state)) return null
  return <CallPill onOpen={(label) => navigationRef.navigate("Call", { label })} />
}

export const navigationRef = createNavigationContainerRef<RootStackParamList>()

// A tap can fire BEFORE the navigation tree mounts — this is the norm on a cold
// start, where getLastNotificationResponseAsync resolves while <NavigationContainer>
// is still initializing. So we buffer the most-recent target and flush it once the
// tree is ready (see flushPendingNav, called from NavigationContainer.onReady and
// after a warm tap). Bailing on !isReady() was why the tap only foregrounded the app.

type PushTap = { data: Record<string, unknown>; title: string }
let pendingTap: PushTap | null = null

// Resolve a push to a screen (lib/notificationRoute) and go there in the same
// frame: no network read stands between the tap and the screen, so the Home
// deck never opens first and swaps underneath. Screens load their own data.
function navToTarget({ data, title }: PushTap): void {
  const target = notificationTarget(data, title)
  if (!target) return
  // Signed out (Server/Login is the root): a screen pushed over it would load with no session.
  const root = navigationRef.getRootState()?.routes?.[0]?.name
  if (root === "Server" || root === "Login") return
  switch (target.to) {
    case "card": return navigationRef.navigate("CardDetail", { id: target.id })
    case "note": return navigationRef.navigate("NoteEditor", { id: target.id })
    case "integrations": return navigationRef.navigate("Integrations")
    case "decision":
      return navigationRef.navigate("Home", { decision: target.kind, ref: target.ref, session: target.session })
    case "inbox": return navigationRef.navigate("Inbox", { session: target.session, title: title.split(" · ")[0] || undefined })
    case "thread":
      return navigationRef.navigate("Thread", {
        host: target.host, label: target.title || "Chat", session: target.session,
      })
  }
}

// Handle a tap: if the tree is ready, navigate now; otherwise stash it so
// flushPendingNav can complete the jump once the container mounts.
function openFromNotification(data: Record<string, unknown>, title: string): void {
  if (navigationRef.isReady()) navToTarget({ data, title })
  else pendingTap = { data, title }
}

// Drain any tap that arrived before navigation was ready (cold start).
function flushPendingNav(): void {
  const tap = pendingTap
  pendingTap = null
  if (tap && navigationRef.isReady()) navToTarget(tap)
}

// A scanned pairing QR (`agents://pair?...`, see lib/pairLink) arrives as a URL
// open — on a cold start via getInitialURL, warm via the 'url' event. Handled
// only after loadConfig (pairing adds a server, which a later hydrate would
// overwrite), and one at a time so a double-delivered URL can't race itself.
let pairing = false
async function openPairLink(url: string | null): Promise<void> {
  if (!url || pairing) return
  pairing = true
  try {
    if (await pairFromLink(url)) {
      if (navigationRef.isReady()) navigationRef.reset({ index: 0, routes: [{ name: "Home" }] })
    }
  } finally {
    pairing = false
  }
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
        if (!hasServer()) setInitial("Server")
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
  useEffect(() => onNotificationTap(openFromNotification), [])
  useEffect(() => setForegroundSuppressor((data) => suppressForeground(data, navigationRef.isReady() ? navigationRef.getCurrentRoute() as any : undefined)), [])

  useEffect(() => {
    if (!ready) return
    Linking.getInitialURL().then(openPairLink).catch(() => {})
    const sub = Linking.addEventListener("url", (e) => void openPairLink(e.url))
    return () => sub.remove()
  }, [ready])

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
        <CallProvider>
        <NavigationContainer
          theme={navTheme}
          ref={navigationRef}
          onReady={() => { flushPendingNav(); startUsageReporting(); trackRoute() }}
          onStateChange={trackRoute}
        >
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
            <Stack.Screen name="Thread" component={ThreadScreen} getId={({ params }) => threadInstanceId(params)} options={({ route }) => ({ title: route.params.label })} />
            <Stack.Screen name="Call" component={CallScreen} options={{ headerShown: false, gestureEnabled: false }} />
            <Stack.Screen name="SessionProfile" component={SessionProfileScreen} options={{ title: "Session" }} />
            <Stack.Screen name="Capabilities" component={CapabilitiesScreen} options={{ title: "Skills & tools" }} />
            <Stack.Screen name="Providers" component={ProvidersScreen} options={{ title: "Model providers" }} />
            <Stack.Screen name="Integrations" component={IntegrationsScreen} options={{ title: "Integrations" }} />
            <Stack.Screen name="Calendar" component={CalendarScreen} options={{ title: "Calendar" }} />
            <Stack.Screen name="Kanban" component={KanbanScreen} options={{ title: "Board" }} />
            <Stack.Screen name="CardDetail" component={CardDetailScreen} options={{ title: "Card" }} />
            <Stack.Screen name="Canvas" component={CanvasScreen} options={{ title: "Canvas" }} />
            <Stack.Screen name="Notes" options={{ title: "Notes" }}>
              {({ navigation, route }) => <NotesScreen navigation={navigation} filter={route.params} title={route.params?.title} tag={route.params?.tag} />}
            </Stack.Screen>
            <Stack.Screen name="Inbox" options={{ title: "Inbox" }}>
              {({ navigation, route }) => (
                <InboxScreen
                  navigation={navigation}
                  session={route.params?.session}
                  title={route.params?.title}
                  host={route.params?.host}
                  path={route.params?.path}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="Files" component={FilesScreen} options={{ title: "Files" }} />
            <Stack.Screen name="Agents" component={AgentsScreen} options={{ title: "Agents" }} />
            <Stack.Screen name="AgentEdit" component={AgentEditScreen}
              options={({ route }) => ({ title: route.params?.template ? "Edit agent" : "New agent" })} />
            <Stack.Screen name="AgentTools" component={AgentToolsScreen}
              options={({ route }) => ({ title: route.params.kind === "skill" ? "Skills" : "MCP tools" })} />
            <Stack.Screen name="NoteEditor" component={NoteEditorScreen} options={{ title: "Note" }} />
            <Stack.Screen name="Org" component={OrgScreen} options={{ title: "Company" }} />
            <Stack.Screen name="Audit" component={AuditScreen} options={{ title: "Activity" }} />
            <Stack.Screen name="AuditEntry" component={AuditEntryScreen} options={{ title: "Recorded action" }} />
            <Stack.Screen name="HostEdit" component={HostEditScreen} options={{ title: "SSH host" }} />
            <Stack.Screen
              name="Terminal"
              component={TerminalScreen}
              options={{ title: "Terminal" }}
            />
          </Stack.Navigator>
        </NavigationContainer>
        <CallPillHost />
        </CallProvider>
        <UndoToast />
        <ActionSheetHost />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
