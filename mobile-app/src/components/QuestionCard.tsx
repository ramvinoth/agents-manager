import React, { useState } from "react"
import { Text, TouchableOpacity, View } from "react-native"
import { allAnswered, isInstant, parseQuestions, pickOption, type AuqQuestion } from "../lib/auq"
import Icon from "./Icon"
import { useStyles } from "../screens/styles"

/**
 * An agent question rendered as tappable quick-reply chips — the messaging-app
 * idiom for "the other side is waiting on you". A lone single-select question
 * answers on tap; anything more complex accumulates picks and shows a submit
 * button. Emits `picks` (one comma-joined label string per question, positionally
 * aligned) — the SERVER composes the message it feeds to the resumed session.
 */
export default function QuestionCard({ input, onAnswer }: { input: unknown; onAnswer: (picks: string[]) => void }) {
  const questions = parseQuestions(input)
  const [picks, setPicks] = useState<Record<number, string[]>>({})
  const [sent, setSent] = useState(false)
  const styles = useStyles()
  if (!questions.length) return null

  function emit(current: Record<number, string[]>) {
    // One string per question (comma-joined for multi-select), aligned by index.
    const out = questions.map((_, qi) => (current[qi] || []).join(", "))
    onAnswer(out)
  }

  function tap(qi: number, label: string, q: AuqQuestion) {
    if (sent) return
    const updated = pickOption(picks, qi, label, q.multiSelect)
    setPicks(updated)
    if (isInstant(questions)) {
      setSent(true)
      emit(updated)
    }
  }

  function submit() {
    if (sent || !allAnswered(questions, picks)) return
    setSent(true)
    emit(picks)
  }

  return (
    <View testID="question-card" style={styles.auqCard}>
      <View style={styles.auqHeader}>
        <Icon name="help" size={15} color="#7a5b00" />
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
                  {picked ? <Icon name="check" size={13} color="#fff" /> : null}
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

      {!isInstant(questions) ? (
        <TouchableOpacity
          testID="auq-submit"
          style={[styles.auqSubmit, !allAnswered(questions, picks) || sent ? { opacity: 0.5 } : null]}
          onPress={submit}
          disabled={sent || !allAnswered(questions, picks)}
        >
          <Text style={styles.auqSubmitText}>{sent ? "Sent" : "Send answer"}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  )
}
