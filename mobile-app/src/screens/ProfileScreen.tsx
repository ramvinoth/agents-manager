import React, { useCallback, useEffect, useState } from "react"
import { ScrollView, Switch, Text, TouchableOpacity, useColorScheme, View } from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { api } from "../api/client"
import {
  notifyEveryReply,
  serverUrl,
  setNotifyEveryReply,
  setThemePref,
  setToken,
  subscribeServer,
  themePref,
  type ThemePref,
} from "../state/config"
import { effectiveScheme } from "../lib/theme"
import { useTheme, useThemePref } from "../lib/useTheme"
import { unregisterPush } from "../lib/notify"
import Icon from "../components/Icon"
import ServerPicker from "../components/ServerPicker"
import { useStyles } from "./styles"

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, keyof RootStackParamList> }

const THEME_OPTS: { v: ThemePref; label: string }[] = [
  { v: "system", label: "System" },
  { v: "light", label: "Light" },
  { v: "dark", label: "Dark" },
]

/**
 * Profile tab: appearance (theme), notifications, account info, and sign out.
 * Consolidates settings that used to live at the top and bottom of the drawer.
 */
export default function ProfileScreen({ navigation }: Props) {
  const styles = useStyles()
  const t = useTheme()
  const pref = useThemePref()
  const os = useColorScheme()
  const [notify, setNotify] = useState(notifyEveryReply())
  // Server picker sheet + a reactive mirror of the active server URL so the row
  // repaints the moment the selection changes (subscribeServer pub-sub).
  const [serverOpen, setServerOpen] = useState(false)
  const [activeUrl, setActiveUrl] = useState(serverUrl())
  useEffect(() => subscribeServer(() => setActiveUrl(serverUrl())), [])

  // Header theme toggle: cycles the preference light → dark → system → light,
  // mirroring the segmented control below. The glyph shows the CURRENT effective
  // scheme (moon when dark, sun when light) so it reads as the active state.
  const dark = effectiveScheme(pref, os) === "dark"
  const cycleTheme = useCallback(() => {
    const order: ThemePref[] = ["light", "dark", "system"]
    const next = order[(order.indexOf(themePref()) + 1) % order.length]
    setThemePref(next)
  }, [])

  // Own the shared parent-stack header on focus: Profile has no host picker on
  // the left, and a theme toggle on the right. Explicitly clearing headerLeft
  // stops the host button from a sibling tab lingering here.
  useFocusEffect(
    useCallback(() => {
      navigation.setOptions({
        title: "Profile",
        headerLeft: () => null,
        headerRight: () => (
          <TouchableOpacity
            testID="theme-toggle"
            accessibilityLabel="toggle-theme"
            onPress={cycleTheme}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center", marginRight: 4 }}
          >
            <Icon name={dark ? "moon" : "sun"} size={22} color={t.accent} />
          </TouchableOpacity>
        ),
      })
    }, [navigation, cycleTheme, dark, t])
  )

  async function signOut() {
    // Stop background pushes to this device before dropping the token.
    await unregisterPush((tok) => api.pushUnregister(tok)).catch(() => {})
    try {
      await api.signout()
    } catch {
      /* best effort */
    }
    await setToken(null)
    navigation.replace("Login")
  }

  function toggleNotify(v: boolean) {
    setNotify(v)
    setNotifyEveryReply(v)
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ paddingBottom: 32 }}>
      <Text style={styles.sheetSection}>APPEARANCE</Text>
      <View style={styles.segRow} testID="theme-switch">
        {THEME_OPTS.map((o) => {
          const active = pref === o.v
          return (
            <TouchableOpacity
              key={o.v}
              testID={`theme-${o.v}`}
              style={[styles.seg, active ? styles.segActive : null]}
              onPress={() => setThemePref(o.v)}
            >
              <Text style={[styles.segText, active ? styles.segTextActive : null]}>{o.label}</Text>
            </TouchableOpacity>
          )
        })}
      </View>

      <Text style={styles.sheetSection}>NOTIFICATIONS</Text>
      <View style={styles.ssRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.ssRowLabel}>Notify every reply</Text>
          <Text style={styles.ssRowHint}>Get a notification each time the agent finishes a turn.</Text>
        </View>
        <Switch
          testID="profile-notify"
          value={notify}
          onValueChange={toggleNotify}
          trackColor={{ true: t.accent, false: t.border }}
        />
      </View>

      <Text style={styles.sheetSection}>ACCOUNT</Text>
      <TouchableOpacity
        testID="open-capabilities"
        style={styles.profileInfoRow}
        onPress={() => navigation.navigate("Capabilities")}
      >
        <Icon name="sparkle" size={18} color={t.accent} />
        <Text style={[styles.profileInfoValue, { color: t.text, flex: 1, marginLeft: 10, textAlign: "left" }]}>Skills & MCP tools</Text>
        <Icon name="chevronRight" size={18} color={t.textMuted} />
      </TouchableOpacity>
      <TouchableOpacity
        testID="open-server-picker"
        style={styles.profileInfoRow}
        onPress={() => setServerOpen(true)}
      >
        <Text style={styles.profileInfoLabel}>Server</Text>
        <Text style={[styles.profileInfoValue, { color: t.text, flex: 1 }]} numberOfLines={1}>
          {activeUrl || "—"}
        </Text>
        <Icon name="chevronRight" size={18} color={t.textMuted} />
      </TouchableOpacity>
      <ServerPicker visible={serverOpen} onClose={() => setServerOpen(false)} navigation={navigation} />

      <TouchableOpacity
        testID="sign-out"
        style={[styles.button, { marginHorizontal: 18, marginTop: 24, backgroundColor: t.danger }]}
        onPress={signOut}
      >
        <Text style={styles.buttonText}>Sign out</Text>
      </TouchableOpacity>
    </ScrollView>
  )
}
