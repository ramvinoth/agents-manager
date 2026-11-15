// Shown in the Inbox until the owner has chosen about push. The OS dialog only
// appears when Turn on is tapped, after this explains why (never at sign-in).

import React, { useCallback, useState } from "react"
import { Text, View } from "react-native"
import { useFocusEffect } from "@react-navigation/native"
import { TouchableOpacity } from "./Tracked"
import { useStyles } from "../lib/styles"
import { pushPermission } from "../lib/notify"
import { registerDevice } from "../state/signin"

export default function PushPromptCard() {
  const styles = useStyles()
  const [show, setShow] = useState(false)
  useFocusEffect(useCallback(() => {
    let live = true
    pushPermission().then((p) => live && setShow(p === "undetermined")).catch(() => {})
    return () => { live = false }
  }, []))
  if (!show) return null
  return (
    <View style={styles.fgCard}>
      <Text style={styles.ibEmptyTitle}>Get a push when we need you</Text>
      <Text style={styles.ibEmptyBody}>Your team asks before it acts. A push tells you the moment there is a question waiting.</Text>
      <TouchableOpacity
        testID="push-turn-on"
        style={styles.button}
        onPress={() => { setShow(false); registerDevice(true).catch(() => {}) }}
      >
        <Text style={styles.buttonText}>Turn on</Text>
      </TouchableOpacity>
    </View>
  )
}
