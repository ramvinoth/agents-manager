import React from "react"
import { Text } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Pressable } from "./Tracked"
import Icon from "./Icon"
import { useCall } from "../lib/CallProvider"
import { fmtElapsed } from "../lib/callSession"
import { useStyles } from "../lib/styles"
import { useTheme } from "../lib/useTheme"

/** Green "In call" bar shown on every screen except the call itself; tap to return. */
export default function CallPill({ onOpen }: { onOpen: (label: string) => void }) {
  const { active, label, elapsed } = useCall()
  const styles = useStyles()
  const t = useTheme()
  const insets = useSafeAreaInsets()
  if (!active) return null
  return (
    <Pressable testID="call-pill" accessibilityLabel="Return to call" onPress={() => onOpen(label)}
      style={[styles.callPill, { top: 0, paddingTop: insets.top + 6 }]}>
      <Icon name="phone" size={16} color={t.onAccent} />
      <Text style={styles.callPillText}>{`In call · ${fmtElapsed(elapsed)} · tap to return`}</Text>
    </Pressable>
  )
}
