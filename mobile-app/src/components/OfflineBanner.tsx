import React from "react"
import { Text, TouchableOpacity, View } from "react-native"
import Icon from "./Icon"
import { useReachability } from "../lib/useReachability"
import { useTheme } from "../lib/useTheme"

/**
 * The one way the app says "can't reach the server" (phone offline, or the
 * server/relay down — the app can't tell which): a calm strip, not a red
 * error, because nothing is broken on the phone — the screen keeps showing its
 * last saved copy and refreshes by itself once the server answers again.
 * Renders nothing while online. `saved` says whether a saved copy is showing.
 */
export default function OfflineBanner({ saved, onRetry }: { saved: boolean; onRetry?: () => void }) {
  const t = useTheme()
  const { online } = useReachability()
  if (online) return null
  return (
    <View
      testID="offline-banner"
      accessibilityRole="alert"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 14,
        paddingVertical: 8,
        backgroundColor: t.chipBg,
        borderBottomWidth: 1,
        borderBottomColor: t.border,
      }}
    >
      <Icon name="offline" size={16} color={t.warning} />
      <Text style={{ flex: 1, fontSize: 13, color: t.text }}>
        {saved ? "Can't reach the server — showing your last saved copy." : "Can't reach the server."}
        <Text style={{ color: t.textMuted }}> It refreshes when you're back.</Text>
      </Text>
      {onRetry ? (
        <TouchableOpacity testID="offline-retry" onPress={onRetry} hitSlop={8}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: t.accent }}>Retry</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  )
}
