// First-run card: shown in an empty Inbox so a new owner's first action is
// stating a goal. Start hands a CEO chat (lib/firstGoal.ts) to the caller.

import React, { useState } from "react"
import { Text, TextInput, View } from "react-native"
import { TouchableOpacity } from "./Tracked"
import { useStyles } from "../lib/styles"
import { GOAL_EXAMPLES, ceoStart, type FirstGoalStart } from "../lib/firstGoal"

export default function FirstGoalCard({ onStart }: { onStart: (first: FirstGoalStart) => void }) {
  const styles = useStyles()
  const [text, setText] = useState("")
  const ready = text.trim().length > 0
  return (
    <View style={styles.fgCard}>
      <Text style={styles.ibEmptyTitle}>What should your team work on first?</Text>
      <TextInput
        testID="first-goal-input"
        style={[styles.input, styles.fgInput]}
        value={text}
        onChangeText={setText}
        placeholder="Describe a goal in a sentence"
        multiline
      />
      <View style={styles.fgChips}>
        {GOAL_EXAMPLES.map((g) => (
          <TouchableOpacity key={g} testID="first-goal-example" style={styles.filterChip} onPress={() => setText(g)}>
            <Text style={styles.filterChipText}>{g}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <TouchableOpacity
        testID="first-goal-start"
        disabled={!ready}
        style={[styles.button, !ready && { opacity: 0.4 }]}
        onPress={() => onStart(ceoStart(text))}
      >
        <Text style={styles.buttonText}>Start</Text>
      </TouchableOpacity>
    </View>
  )
}
