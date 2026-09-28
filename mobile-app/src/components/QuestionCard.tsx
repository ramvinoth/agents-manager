import React, { useEffect, useMemo, useState } from "react"
import { Text, TextInput, TouchableOpacity, View } from "react-native"
import { allAnswered, isInstant, parseQuestions, pickOption, type AuqQuestion } from "../lib/auq"
import Icon from "./Icon"
import { useStyles } from "../screens/styles"
import { useTheme } from "../lib/useTheme"

/**
 * An agent question rendered as tappable quick-reply chips — the messaging-app
 * idiom for "the other side is waiting on you". A lone single-select question
 * answers on tap; anything more complex accumulates picks and shows a submit
 * button. Emits `picks` (one comma-joined label string per question, positionally
 * aligned) plus an optional typed `note` — the SERVER composes the message it
 * feeds to the resumed session. The note is the follow-up path: when no offered
 * option fits, or a pick needs a condition, the owner's own words are the
 * answer and travel through the same answer route (never the chat queue).
 */
export default function QuestionCard({ input, onAnswer }: { input: unknown; onAnswer: (picks: string[], note: string) => void }) {
  // Parse once per distinct input (not every render — parseQuestions returns a
  // fresh array each call, which would churn child renders).
  const questions = useMemo(() => parseQuestions(input), [input])
  const [picks, setPicks] = useState<Record<number, string[]>>({})
  const [note, setNote] = useState("")
  const [sent, setSent] = useState(false)
  const styles = useStyles()
  const t = useTheme()
  const hasNote = note.trim().length > 0
  // If the server pushes a NEW question set into this same mounted card, reset
  // the positional picks/sent so stale answers don't bleed across.
  const qKey = useMemo(() => questions.map((q) => q.question).join(""), [questions])
  useEffect(() => {
    setPicks({})
    setNote("")
    setSent(false)
  }, [qKey])
  if (!questions.length) return null

  function emit(current: Record<number, string[]>) {
    // One string per question (comma-joined for multi-select), aligned by index.
    const out = questions.map((_, qi) => (current[qi] || []).join(", "))
    onAnswer(out, note.trim())
  }

  function tap(qi: number, label: string, q: AuqQuestion) {
    if (sent) return
    const updated = pickOption(picks, qi, label, q.multiSelect)
    setPicks(updated)
    // A typed reply in progress holds the instant tap so the note travels with the pick.
    if (isInstant(questions) && !hasNote) {
      setSent(true)
      emit(updated)
    }
  }

  const canSubmit = allAnswered(questions, picks) || hasNote

  function submit() {
    if (sent || !canSubmit) return
    setSent(true)
    emit(picks)
  }

  return (
    <View testID="question-card" style={styles.auqCard}>
      <View style={styles.auqHeader}>
        <Icon name="help" size={15} color={t.attentionMuted} />
        <Text style={styles.auqHeaderText}>Claude is asking</Text>
      </View>

      {questions.map((q, qi) => (
        <View key={qi} style={{ marginTop: qi ? 10 : 4 }}>
          <Text style={styles.auqQuestion}>{q.question}</Text>
          <View style={styles.auqOptions}>
            {q.options.map((o) => {
              const picked = (picks[qi] || []).includes(o.label)
              return (
                <TouchableOpacity
                  key={o.label}
                  testID={`auq-option-${o.label}`}
                  style={[styles.auqChip, picked ? styles.auqChipPicked : null, sent ? { opacity: 0.6 } : null]}
                  onPress={() => tap(qi, o.label, q)}
                  disabled={sent}
                >
                  {picked ? <Icon name="check" size={13} color={t.onAccent} /> : null}
                  <Text style={[styles.auqChipText, picked ? styles.auqChipTextPicked : null]}>{o.label}</Text>
                </TouchableOpacity>
              )
            })}
          </View>
          {/* Show the description of the currently picked option — context without clutter. */}
          {(picks[qi] || []).length === 1
            ? (() => {
                const d = q.options.find((o) => o.label === picks[qi][0])?.description
                return d ? <Text style={styles.auqDesc}>{d}</Text> : null
              })()
            : null}
        </View>
      ))}

      <TextInput
        testID="auq-note"
        style={styles.auqNote}
        value={note}
        onChangeText={setNote}
        editable={!sent}
        multiline
        placeholder="Or write your own reply — none fit, a condition, a question back…"
        placeholderTextColor={t.attentionMuted}
      />

      {!isInstant(questions) || hasNote ? (
        <TouchableOpacity
          testID="auq-submit"
          style={[styles.auqSubmit, !canSubmit || sent ? { opacity: 0.5 } : null]}
          onPress={submit}
          disabled={sent || !canSubmit}
        >
          <Text style={styles.auqSubmitText}>
            {sent ? "Sent" : hasNote && !allAnswered(questions, picks) ? "Send reply" : "Send answer"}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  )
}
