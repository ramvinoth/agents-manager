import React, { useEffect, useRef, useState } from "react"
import { Text, View } from "react-native"
import { createMaterialTopTabNavigator } from "@react-navigation/material-top-tabs"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import ChatsScreen from "./ChatsScreen"
import FilesTab from "./FilesTab"
import AgentsScreen from "./AgentsScreen"
import ProfileScreen from "./ProfileScreen"
import NotesScreen from "./NotesScreen"
import InboxScreen from "./InboxScreen"
import Icon, { type IconName } from "../components/Icon"
import { api } from "../api/client"
import { useTheme } from "../lib/useTheme"

export type HomeTabParamList = {
  Chats: undefined
  Inbox: undefined
  Files: undefined
  Notes: undefined
  Agents: undefined
  Profile: undefined
}

const Tab = createMaterialTopTabNavigator<HomeTabParamList>()

// Outline when inactive, filled when active — the WhatsApp convention.
const TAB_ICON: Record<keyof HomeTabParamList, { on: IconName; off: IconName }> = {
  Chats: { on: "chatFilled", off: "chat" },
  Inbox: { on: "mailFilled", off: "mail" },
  Files: { on: "file", off: "file" },
  Notes: { on: "book", off: "book" },
  Agents: { on: "sparkle", off: "sparkle" },
  Profile: { on: "userFilled", off: "user" },
}

type Props = NativeStackScreenProps<RootStackParamList, "Home">

/**
 * WhatsApp-style bottom tab bar with left/right swipe between tabs. Built on
 * material-top-tabs with `tabBarPosition: "bottom"` so we get the swipe pager
 * that plain bottom-tabs lacks. Nested inside the root stack, so each tab can
 * still push Thread / NewChat / Files / Terminal on the parent stack.
 *
 * The active tab is marked by a filled icon inside a tinted "pill" (like
 * WhatsApp), not a top indicator line — that reads as native, not web tabs.
 */
export default function HomeTabs({ navigation }: Props) {
  const t = useTheme()
  const insets = useSafeAreaInsets()

  // The Inbox badge: how many messages/decisions wait on this reader. It has to
  // update while ANOTHER tab is showing (that's the point of a badge), so the
  // count is polled here at the navigator level — not inside InboxScreen, which
  // only mounts/refreshes when the Inbox tab itself is focused. Cheap unscoped
  // list; a failure just leaves the last count (no error surface on a badge).
  const [inboxUnread, setInboxUnread] = useState(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    const poll = () => {
      api.inboxList({})
        .then((r) => { if (alive.current) setInboxUnread(r.unread || 0) })
        .catch(() => {})
    }
    poll()
    const id = setInterval(poll, 15000)
    return () => { alive.current = false; clearInterval(id) }
  }, [])

  return (
    <Tab.Navigator
      tabBarPosition="bottom"
      screenOptions={({ route }) => ({
        swipeEnabled: true,
        tabBarActiveTintColor: t.accent,
        tabBarInactiveTintColor: t.textMuted,
        tabBarShowIcon: true,
        // Hide the built-in label slot: material-top-tabs lays icon+label in a
        // ROW, which pushes the icon left of the text. We render both together
        // as one centered column inside tabBarIcon instead.
        tabBarShowLabel: false,
        tabBarPressColor: "transparent",
        tabBarStyle: {
          backgroundColor: t.surface,
          borderTopWidth: 1,
          borderTopColor: t.border,
          paddingBottom: insets.bottom,
          paddingTop: 4,
          elevation: 0,
          shadowOpacity: 0,
        },
        tabBarItemStyle: { paddingVertical: 2 },
        // Hide the top indicator line — the pill behind the icon marks active.
        tabBarIndicatorStyle: { height: 0 },
        tabBarIcon: ({ color, focused }) => {
          const spec = TAB_ICON[route.name]
          const badge = route.name === "Inbox" && inboxUnread > 0 ? inboxUnread : 0
          return (
            // 58, not 64: six tabs must fit a 375pt screen without the tab bar
            // scrolling (6×64=384 would).
            <View style={{ alignItems: "center", justifyContent: "center", width: 58 }}>
              {/* No pill/enclosure behind the icon: the active tab is already
                  marked by the icon+label recoloring to the accent, so a tinted
                  background would be redundant. */}
              <View style={{ width: 48, height: 26, alignItems: "center", justifyContent: "center" }}>
                <Icon name={focused ? spec.on : spec.off} size={20} color={color} />
                {badge ? (
                  <View
                    testID="inbox-tab-badge"
                    style={{
                      position: "absolute", top: -2, right: 6, minWidth: 16, height: 16,
                      borderRadius: 8, paddingHorizontal: 4, backgroundColor: t.danger,
                      alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <Text style={{ color: "#fff", fontSize: 10, fontWeight: "700" }}>
                      {badge > 99 ? "99+" : badge}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text
                style={{ fontSize: 11, fontWeight: "600", color, marginTop: 2, textAlign: "center" }}
                numberOfLines={1}
              >
                {route.name}
              </Text>
            </View>
          )
        },
      })}
    >
      <Tab.Screen name="Chats">{() => <ChatsScreen navigation={navigation} />}</Tab.Screen>
      <Tab.Screen name="Inbox">{() => <InboxScreen navigation={navigation} isTab />}</Tab.Screen>
      <Tab.Screen name="Files">{() => <FilesTab navigation={navigation} />}</Tab.Screen>
      <Tab.Screen name="Notes">{() => <NotesScreen navigation={navigation} isTab />}</Tab.Screen>
      <Tab.Screen name="Agents">{() => <AgentsScreen navigation={navigation} />}</Tab.Screen>
      <Tab.Screen name="Profile">{() => <ProfileScreen navigation={navigation} />}</Tab.Screen>
    </Tab.Navigator>
  )
}
