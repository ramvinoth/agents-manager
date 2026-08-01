import React from "react"
import { Text, View } from "react-native"
import { createMaterialTopTabNavigator } from "@react-navigation/material-top-tabs"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import ChatsScreen from "./ChatsScreen"
import FilesTab from "./FilesTab"
import ProjectsScreen from "./ProjectsScreen"
import ProfileScreen from "./ProfileScreen"
import Icon, { type IconName } from "../components/Icon"
import { useTheme } from "../lib/useTheme"

export type HomeTabParamList = {
  Chats: undefined
  Files: undefined
  Projects: undefined
  Profile: undefined
}

const Tab = createMaterialTopTabNavigator<HomeTabParamList>()

// Outline when inactive, filled when active — the WhatsApp convention.
const TAB_ICON: Record<keyof HomeTabParamList, { on: IconName; off: IconName }> = {
  Chats: { on: "chatFilled", off: "chat" },
  Files: { on: "file", off: "file" },
  Projects: { on: "folderFilled", off: "folder" },
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
          return (
            <View style={{ alignItems: "center", justifyContent: "center", width: 64 }}>
              {/* No pill/enclosure behind the icon: the active tab is already
                  marked by the icon+label recoloring to the accent, so a tinted
                  background would be redundant. */}
              <View style={{ width: 48, height: 26, alignItems: "center", justifyContent: "center" }}>
                <Icon name={focused ? spec.on : spec.off} size={20} color={color} />
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
      <Tab.Screen name="Files">{() => <FilesTab navigation={navigation} />}</Tab.Screen>
      <Tab.Screen name="Projects">{() => <ProjectsScreen navigation={navigation} />}</Tab.Screen>
      <Tab.Screen name="Profile">{() => <ProfileScreen navigation={navigation} />}</Tab.Screen>
    </Tab.Navigator>
  )
}
