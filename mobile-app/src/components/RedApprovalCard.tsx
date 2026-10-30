import React from "react"
import { Text, TouchableOpacity, View } from "react-native"
import type { RedAsk } from "../api/client"
import type { RedResolution } from "../lib/redApproval"
import { useStyles } from "../lib/styles"
import { useTheme } from "../lib/useTheme"

/**
 * An org (Red) approval — the ONE rendering, shared by the decision cockpit
 * and the asking session's chat (card 223), so the two cannot drift. Both
 * decide through lib/redApproval's resolveRed. `headline` names the ask where
 * the surrounding screen does not (the chat); `error` is the last failure.
 */
export default function RedApprovalCard({ ask, busy, onDecide, testID, headline, error }: {
  ask: RedAsk
  busy: boolean
  onDecide: (resolution: RedResolution) => void
  testID: string
  headline?: string
  error?: string
}) {
  const styles = useStyles()
  const t = useTheme()
  return (
    <View testID={testID} style={styles.permCard}>
      {headline ? <Text style={[styles.permTitle, { color: t.danger }]}>{headline}</Text> : null}
      <Text style={styles.permTitle}>Why it asks</Text>
      <Text testID={`${testID}-reason`} style={styles.permInput}>{ask.reason || "No reason given — deny it and the agent can ask again with one."}</Text>
      <Text style={styles.permTitle}>If you approve</Text>
      <Text style={styles.permInput}>{ask.risk || "The action runs."}</Text>
      <Text style={styles.permInput}>Deny and nothing happens. The asking session is told either way.</Text>
      {error ? <Text testID={`${testID}-error`} style={[styles.permInput, { color: t.danger }]}>{error}</Text> : null}
      <View style={styles.permBtnRow}>
        <TouchableOpacity testID={`${testID}-deny`} style={styles.permDeny} onPress={() => onDecide("denied")} disabled={busy}>
          <Text style={styles.permDenyText}>Deny</Text>
        </TouchableOpacity>
        <TouchableOpacity testID={`${testID}-approve`} style={styles.permAllow} onPress={() => onDecide("approved")} disabled={busy}>
          <Text style={styles.permAllowText}>Approve</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}
