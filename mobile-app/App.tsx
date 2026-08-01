import React, { useEffect, useState } from "react"
import { ActivityIndicator, useColorScheme, View } from "react-native"
import { GestureHandlerRootView } from "react-native-gesture-handler"
import { StatusBar } from "expo-status-bar"
import { DarkTheme, DefaultTheme, NavigationContainer, type Theme as NavTheme } from "@react-navigation/native"
import { createNativeStackNavigator } from "@react-navigation/native-stack"
import { effectiveScheme, themeFor } from "./src/lib/theme"
import { useThemePref } from "./src/lib/useTheme"
// Required by useSafeAreaInsets (the composer pads for the home indicator).
// React Navigation 6 does NOT provide this automatically.
import { SafeAreaProvider } from "react-native-safe-area-context"
import type { Host as HostConfig } from "./src/api/client"
import { api } from "./src/api/client"
import { loadConfig, serverUrl, token } from "./src/state/config"
import { registerForPush } from "./src/lib/notify"
import ServerScreen from "./src/screens/ServerScreen"
import LoginScreen from "./src/screens/LoginScreen"
import HomeTabs from "./src/screens/HomeTabs"
import NewChatScreen from "./src/screens/NewChatScreen"
import ThreadScreen from "./src/screens/ThreadScreen"
import FilesScreen from "./src/screens/FilesScreen"
import SessionInfoScreen from "./src/screens/SessionInfoScreen"
import SessionProfileScreen from "./src/screens/SessionProfileScreen"
import CapabilitiesScreen from "./src/screens/CapabilitiesScreen"
import HostEditScreen from "./src/screens/HostEditScreen"
import TerminalScreen from "./src/screens/TerminalScreen"

export type RootStackParamList = {
  Server: { mode?: "initial" | "add" } | undefined
  Login: undefined
  Home: undefined
  NewChat: undefined
  Thread: { host: string; label: string; path?: string; jumpTo?: string }
  Files: { host: string; path?: string }
  SessionInfo: { host: string; path: string }
  SessionProfile: { host: string; label: string; path?: string; sessionId: string }
  Capabilities: undefined
  HostEdit: { host?: HostConfig } | undefined
  Terminal: { host: string; label: string }
}

const Stack = createNativeStackNavigator<RootStackParamList>()

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
        <NavigationContainer theme={navTheme}>
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
            <Stack.Screen name="Files" component={FilesScreen} options={{ title: "Files" }} />
            <Stack.Screen name="SessionInfo" component={SessionInfoScreen} options={{ title: "Session info" }} />
            <Stack.Screen name="SessionProfile" component={SessionProfileScreen} options={{ title: "Session" }} />
            <Stack.Screen name="Capabilities" component={CapabilitiesScreen} options={{ title: "Skills & tools" }} />
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
