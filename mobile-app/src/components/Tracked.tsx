// Tracked.tsx — the app's only TouchableOpacity and Pressable: React Native's
// own, with each press counted for the owner's usage report (rules:
// lib/usage.ts tapName, queue: lib/usageReporter.ts). Every screen imports
// these instead of react-native's; usage.test.ts fails a direct import.
//
// React Native has no global press hook that can see which control was
// pressed, so the count lives at the one place every press passes through.
// The press handler is passed through untouched; counting can never break it.

import React, { forwardRef } from "react"
import * as RN from "react-native"
import { recordTap } from "../lib/usageReporter"

/** The same handler type back (TouchableOpacity's and Pressable's differ on null). */
function counted<H extends ((e: RN.GestureResponderEvent) => void) | null | undefined>(
  onPress: H, testID?: string, accessibilityLabel?: string,
): H {
  if (!onPress) return onPress
  return ((e: RN.GestureResponderEvent) => {
    // Counted before the handler runs: a press that navigates belongs to the
    // screen it was made on, not the one it opens.
    try { recordTap({ testID, accessibilityLabel }) } catch { /* telemetry never surfaces */ }
    onPress(e)
  }) as H
}

export const TouchableOpacity = forwardRef<React.ElementRef<typeof RN.TouchableOpacity>, RN.TouchableOpacityProps>(
  function TouchableOpacity(props, ref) {
    return <RN.TouchableOpacity ref={ref} {...props} onPress={counted(props.onPress, props.testID, props.accessibilityLabel)} />
  },
)

export const Pressable = forwardRef<RN.View, RN.PressableProps>(function Pressable(props, ref) {
  return <RN.Pressable ref={ref} {...props} onPress={counted(props.onPress, props.testID, props.accessibilityLabel)} />
})
