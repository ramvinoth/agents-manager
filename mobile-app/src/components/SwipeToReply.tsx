import React, { useMemo, useRef } from "react"
import { View } from "react-native"
import { Gesture, GestureDetector } from "react-native-gesture-handler"
import Animated, { Extrapolation, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated"
import Icon from "./Icon"
import { useStyles } from "../lib/styles"
import { useTheme } from "../lib/useTheme"

const TRIGGER = 56 // px of drag before the reply fires — comfortably past a scroll jitter
const EDGE = 30 // px from the screen's left edge reserved for iOS's native swipe-back

/**
 * WhatsApp-style swipe-to-reply. Drag a message right; past the threshold it
 * springs back and quotes the message into the composer. The drag runs on the
 * UI thread, so it stays smooth while the thread list re-renders underneath.
 */
export default function SwipeToReply({
  onReply,
  children,
}: {
  onReply: () => void
  children: React.ReactNode
}) {
  const x = useSharedValue(0)
  const styles = useStyles()
  const t = useTheme()
  // The gesture is memoized, so call the latest onReply through a ref — in a
  // FlatList the inline closure changes every render.
  const onReplyRef = useRef(onReply)
  onReplyRef.current = onReply
  const fire = () => onReplyRef.current()

  const pan = useMemo(() => Gesture.Pan()
    // Claim only a decidedly rightward drag; vertical scroll and left drags pass through.
    // A touch starting at the screen edge is iOS's back swipe — never compete for it.
    .onTouchesDown((e, state) => {
      if (e.allTouches[0] && e.allTouches[0].absoluteX < EDGE) state.fail()
    })
    .activeOffsetX(12)
    .failOffsetX(-12)
    .failOffsetY([-10, 10])
    .onUpdate((e) => {
      const dx = Math.max(0, e.translationX)
      // Resistance past the trigger point so it feels like it "catches".
      x.value = dx > TRIGGER ? TRIGGER + (dx - TRIGGER) * 0.25 : dx
    })
    .onEnd((e) => {
      if (e.translationX >= TRIGGER) runOnJS(fire)()
    })
    .onFinalize(() => {
      x.value = withSpring(0, { damping: 18, stiffness: 220 })
    }), [])

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }))
  // The ↩ hint fades in as you drag, so the affordance is discoverable.
  const hintStyle = useAnimatedStyle(() => ({ opacity: interpolate(x.value, [0, TRIGGER], [0, 1], Extrapolation.CLAMP) }))

  return (
    <View>
      <Animated.View style={[styles.swipeHint, hintStyle]} pointerEvents="none">
        <Icon name="reply" size={18} color={t.textMuted} />
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={rowStyle}>{children}</Animated.View>
      </GestureDetector>
    </View>
  )
}
