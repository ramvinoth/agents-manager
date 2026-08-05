import React, { useRef } from "react"
import { Animated, PanResponder, View } from "react-native"
import Icon from "./Icon"
import { useStyles } from "../screens/styles"

const TRIGGER = 56 // px of drag before the reply fires — comfortably past a scroll jitter

/**
 * WhatsApp-style swipe-to-reply. Drag a message right; past the threshold it
 * springs back and quotes the message into the composer.
 *
 * Uses the built-in PanResponder rather than react-native-gesture-handler: a new
 * native dependency would force a ~15 min rebuild, and this gesture is simple
 * enough that the built-in is sufficient.
 */
export default function SwipeToReply({
  onReply,
  children,
}: {
  onReply: () => void
  children: React.ReactNode
}) {
  const x = useRef(new Animated.Value(0)).current
  const fired = useRef(false)
  const styles = useStyles()
  // The PanResponder is created ONCE (useRef), so it would capture the first
  // render's onReply forever — in a FlatList that inline closure changes every
  // render, so a swipe after a re-render would reply to the WRONG message. Keep
  // the latest callback in a ref and call through it.
  const onReplyRef = useRef(onReply)
  onReplyRef.current = onReply

  const pan = useRef(
    PanResponder.create({
      // Claim the gesture only for a decidedly horizontal drag, so the vertical
      // list scroll keeps working normally.
      onMoveShouldSetPanResponder: (_e, g) => g.dx > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
      onPanResponderGrant: () => {
        fired.current = false
      },
      onPanResponderMove: (_e, g) => {
        if (g.dx < 0) return // right-drag only
        // Resistance past the trigger point so it feels like it "catches".
        const d = g.dx > TRIGGER ? TRIGGER + (g.dx - TRIGGER) * 0.25 : g.dx
        x.setValue(d)
        if (!fired.current && g.dx >= TRIGGER) fired.current = true
      },
      onPanResponderRelease: () => {
        if (fired.current) onReplyRef.current()
        Animated.spring(x, { toValue: 0, useNativeDriver: true, bounciness: 6 }).start()
      },
      onPanResponderTerminate: () => {
        Animated.spring(x, { toValue: 0, useNativeDriver: true }).start()
      },
    })
  ).current

  // The ↩ hint fades in as you drag, so the affordance is discoverable.
  const hintOpacity = x.interpolate({ inputRange: [0, TRIGGER], outputRange: [0, 1], extrapolate: "clamp" })

  return (
    <View>
      <Animated.View style={[styles.swipeHint, { opacity: hintOpacity }]} pointerEvents="none">
        <Icon name="reply" size={18} color="#8a8a8a" />
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX: x }] }} {...pan.panHandlers}>
        {children}
      </Animated.View>
    </View>
  )
}
