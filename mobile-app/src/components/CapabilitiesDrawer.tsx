/**
 * CapabilitiesDrawer — a right-side slide-in panel showing Skills and MCP tools
 * for the current session (the list is the shared CapabilitiesPanel).
 *
 * Opens from the tools icon in the ThreadScreen header (rightmost icon).
 * Dismisses on backdrop tap, swipe-right, or toggling the icon again.
 */
import React, { useEffect, useRef, useState } from "react"
import { Animated, Dimensions, PanResponder, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useTheme } from "../lib/useTheme"
import CapabilitiesPanel from "./CapabilitiesPanel"
import Icon from "./Icon"

const SCREEN_W = Dimensions.get("window").width
const DRAWER_W = Math.min(SCREEN_W * 0.85, 360)

interface Props {
  visible: boolean
  host: string
  cwd?: string
  /** Session rel path — surfaces this session's attached plugin skills. */
  session?: string
  onClose: () => void
}

export default function CapabilitiesDrawer({ visible, host, cwd, session, onClose }: Props) {
  const t = useTheme()
  const insets = useSafeAreaInsets()

  const slideAnim = useRef(new Animated.Value(DRAWER_W)).current
  const backdropAnim = useRef(new Animated.Value(0)).current
  const [rendered, setRendered] = useState(false)

  // Animate open/close
  useEffect(() => {
    if (visible) {
      setRendered(true)
      Animated.parallel([
        Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, tension: 65, friction: 11 }),
        Animated.timing(backdropAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start()
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, { toValue: DRAWER_W, duration: 200, useNativeDriver: true }),
        Animated.timing(backdropAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start(() => setRendered(false))
    }
  }, [visible])

  // Swipe-right to dismiss
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dx > 15 && Math.abs(g.dy) < 30,
      onPanResponderMove: (_, g) => {
        if (g.dx > 0) slideAnim.setValue(g.dx)
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx > DRAWER_W * 0.3 || g.vx > 0.5) {
          onClose()
        } else {
          Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true }).start()
        }
      },
    })
  ).current

  if (!rendered) return null

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Backdrop */}
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: "rgba(0,0,0,0.4)", opacity: backdropAnim },
          ]}
        />
      </Pressable>

      {/* Drawer */}
      <Animated.View
        {...panResponder.panHandlers}
        style={[
          localStyles.drawer,
          {
            width: DRAWER_W,
            backgroundColor: t.bg,
            paddingBottom: insets.bottom,
            transform: [{ translateX: slideAnim }],
          },
        ]}
      >
        {/* The drawer fills the content area below the native nav header, which
            already occupies the top safe-area — so the header row sits flush to
            the top with no extra inset padding. */}
        <View style={localStyles.header}>
          <Text style={[localStyles.headerTitle, { color: t.text }]}>Skills & tools</Text>
          <TouchableOpacity onPress={onClose} hitSlop={8}>
            <Icon name="close" size={20} color={t.textMuted} />
          </TouchableOpacity>
        </View>

        <CapabilitiesPanel host={host} cwd={cwd} session={session} active={visible} testPrefix="drawer" />
      </Animated.View>
    </View>
  )
}

const localStyles = StyleSheet.create({
  drawer: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    shadowColor: "#000",
    shadowOffset: { width: -2, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "700",
  },
})
