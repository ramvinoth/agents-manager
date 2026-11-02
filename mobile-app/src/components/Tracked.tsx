// Tracked.tsx — the app's only TouchableOpacity and Pressable: React Native's
// own, with each press and long-press counted, and each named control counted
// as seen while its screen is in front, for the owner's usage report (rules:
// lib/usage.ts, queue: lib/usageReporter.ts). Every screen imports these
// instead of react-native's; usage.test.ts fails a direct import.
//
// React Native has no global press hook that can see which control was
// pressed, so the count lives at the one place every press passes through.
// Handlers are passed through untouched; counting can never break them.

import React, { forwardRef, useContext, useEffect } from "react"
import * as RN from "react-native"
import { NavigationContext } from "@react-navigation/native"
import type { UseKind } from "../lib/usage"
import { controlMounted, recordUse } from "../lib/usageReporter"

/** The same handler type back (TouchableOpacity's and Pressable's differ on null). */
function counted<H extends ((e: RN.GestureResponderEvent) => void) | null | undefined>(
  kind: UseKind, handler: H, testID?: string, accessibilityLabel?: string,
): H {
  if (!handler) return handler
  return ((e: RN.GestureResponderEvent) => {
    // Counted before the handler runs: a press that navigates belongs to the
    // screen it was made on, not the one it opens.
    try { recordUse(kind, { testID, accessibilityLabel }) } catch { /* telemetry never surfaces */ }
    handler(e)
  }) as H
}

/** Count a control as on screen while it is mounted and its screen is in
 *  front. NavigationContext, not useNavigation: a control outside any
 *  navigator (an app-level overlay) is on whatever screen is in front. A
 *  control nothing can press (no handler) is not a control. */
export function useSeen(testID: string | undefined, accessibilityLabel: string | undefined, usable: boolean) {
  const navigation = useContext(NavigationContext)
  useEffect(() => {
    if (!usable) return
    return controlMounted({ testID, accessibilityLabel }, () => !navigation || navigation.isFocused())
  }, [navigation, testID, accessibilityLabel, usable])
}

export const TouchableOpacity = forwardRef<React.ElementRef<typeof RN.TouchableOpacity>, RN.TouchableOpacityProps>(
  function TouchableOpacity(props, ref) {
    useSeen(props.testID, props.accessibilityLabel, !props.disabled && !!(props.onPress || props.onLongPress))
    return (
      <RN.TouchableOpacity
        ref={ref}
        {...props}
        onPress={counted("tap", props.onPress, props.testID, props.accessibilityLabel)}
        onLongPress={counted("long_press", props.onLongPress, props.testID, props.accessibilityLabel)}
      />
    )
  },
)

export const Pressable = forwardRef<RN.View, RN.PressableProps>(function Pressable(props, ref) {
  useSeen(props.testID, props.accessibilityLabel, !props.disabled && !!(props.onPress || props.onLongPress))
  return (
    <RN.Pressable
      ref={ref}
      {...props}
      onPress={counted("tap", props.onPress, props.testID, props.accessibilityLabel)}
      onLongPress={counted("long_press", props.onLongPress, props.testID, props.accessibilityLabel)}
    />
  )
})
