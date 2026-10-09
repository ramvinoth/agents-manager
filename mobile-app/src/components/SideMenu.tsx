import React, { createContext, useContext, useEffect, useState } from "react"
import { Animated, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import Icon from "./Icon"
import HeaderButton from "./HeaderButton"
import { MENU_SECTIONS, type MenuItem } from "../lib/menu"
import { useTheme } from "../lib/useTheme"

/** Opens the side menu. Provided by HomeTabs; each home tab reads it through
 *  useMenuButton and hands the closure to its header (the native header is
 *  rendered by the parent stack, outside this provider, so it cannot read the
 *  context itself). */
const SideMenuContext = createContext<() => void>(() => {})
export const SideMenuProvider = SideMenuContext.Provider

/** The hamburger for a home tab's headerLeft — the same control on every tab. */
export function useMenuButton(): () => React.ReactNode {
  const open = useContext(SideMenuContext)
  const t = useTheme()
  return () => (
    <HeaderButton testID="menu-button" label="Open menu" icon="menu" size={24} color={t.accent} onPress={open} />
  )
}

/**
 * The left side menu: every place that is not a daily bottom tab (Files,
 * Notes, Agents, the board, Integrations…), one tap from any home tab. The
 * scrim fades while only the panel slides, like SheetModal. Items come from
 * lib/menu (one list, tested); a tap closes the menu and pushes the screen on
 * the root stack, so Back returns to the tab the owner came from.
 */
/** The panel's width on a screen this wide — the drag maps a finger's travel onto it. */
export function menuPanelWidth(screenWidth: number): number {
  return Math.min(320, Math.round(screenWidth * 0.82))
}

export default function SideMenu({ visible, dragging, progress, onClose, navigation }: {
  visible: boolean
  /** A finger is pulling the menu out: the panel tracks `progress` and does not animate. */
  dragging: boolean
  /** 0 shut … 1 open. Owned by the caller so a drag can set it frame by frame without a render. */
  progress: Animated.Value
  onClose: () => void
  navigation: NativeStackNavigationProp<RootStackParamList, keyof RootStackParamList>
}) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const panelW = menuPanelWidth(width)
  const anim = progress
  // The Modal must OUTLIVE the close animation: binding its `visible` straight
  // to the prop unmounts it in the same commit the panel starts sliding out, so
  // the exit never renders (it pops). `mounted` keeps the Modal up until the
  // slide-out finishes, then unmounts.
  // A drag mounts it too, and on release it settles from wherever the finger left it.
  const [mounted, setMounted] = useState(visible || dragging)

  useEffect(() => {
    if (dragging) { setMounted(true); return }
    if (visible) setMounted(true)
    Animated.timing(anim, { toValue: visible ? 1 : 0, duration: visible ? 220 : 160, useNativeDriver: true })
      .start(({ finished }) => { if (finished && !visible) setMounted(false) })
  }, [visible, dragging, anim])

  const go = (item: MenuItem) => {
    onClose()
    // A union of route names with differing param shapes: every menu route
    // takes no params, which lib/menu's type guarantees.
    navigation.navigate(item.route as never)
  }

  return (
    <Modal transparent visible={mounted} animationType="none" onRequestClose={onClose}>
      {/* accessible={false}: an accessible Pressable folds its subtree into one
          element, hiding every menu row from VoiceOver and XCUITest. */}
      <Pressable testID="menu-scrim" accessible={false} style={{ flex: 1 }} onPress={onClose}>
        <Animated.View pointerEvents="none"
          style={[StyleSheet.absoluteFillObject, { backgroundColor: "rgba(0,0,0,0.45)", opacity: anim }]} />
        <Animated.View style={{
          position: "absolute", top: 0, bottom: 0, left: 0, width: panelW, backgroundColor: t.surface,
          transform: [{ translateX: anim.interpolate({ inputRange: [0, 1], outputRange: [-panelW, 0] }) }],
        }}>
          <Pressable testID="side-menu" accessible={false} style={{ flex: 1, paddingTop: insets.top + 12, paddingBottom: insets.bottom }}
            onPress={(e) => e.stopPropagation()}>
            <Text style={{ color: t.text, fontSize: 24, fontWeight: "800", paddingHorizontal: 20, marginBottom: 8 }}>Harman</Text>
            <ScrollView>
              {MENU_SECTIONS.map((s) => (
                <View key={s.title} style={{ marginTop: 14 }}>
                  <Text style={{ color: t.textMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.6, paddingHorizontal: 20, marginBottom: 4 }}>
                    {s.title.toUpperCase()}
                  </Text>
                  {s.items.map((item) => (
                    <TouchableOpacity key={item.route} testID={`menu-${item.route}`} onPress={() => go(item)}
                      style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 12, gap: 14 }}>
                      <Icon name={item.icon} size={21} color={t.accent} />
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: t.text, fontSize: 16, fontWeight: "600" }}>{item.label}</Text>
                        <Text style={{ color: t.textMuted, fontSize: 12, marginTop: 1 }} numberOfLines={1}>{item.hint}</Text>
                      </View>
                    </TouchableOpacity>
                  ))}
                </View>
              ))}
            </ScrollView>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  )
}
