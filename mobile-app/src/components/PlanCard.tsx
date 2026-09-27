import React, { useEffect, useMemo, useRef, useState } from "react"
import { Text, TextInput, TouchableOpacity, View } from "react-native"
import { planDecision, planStateLabel, planText } from "../lib/plan"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../screens/styles"
import Icon from "./Icon"
import Markdown from "./Markdown"

/** A proposed plan (ExitPlanMode). Rendered as a distinct card with the plan as
 *  formatted markdown. When `onDecide` is given (a live pending plan), shows
 *  Approve / Deny — deny reveals a feedback box so the agent can revise.
 *  A decided plan (its tool_result has landed) folds to its header so a long
 *  plan doesn't own the scrollback forever; tapping reopens it.
 *
 *  Shared by the thread (inline pending + historical result blocks) and the
 *  board decision cockpit — one renderer, so a plan reads and decides the same
 *  way wherever it surfaces. */
export default function PlanCard({
  input,
  result,
  onDecide,
}: {
  input: unknown
  result?: unknown
  onDecide?: (d: "approve" | "deny", feedback?: string) => void
}) {
  const t = useTheme()
  const styles = useStyles()
  const state = planDecision(result)
  const pending = state === "pending"
  const [open, setOpen] = useState(pending)
  const [denying, setDenying] = useState(false)
  const [feedback, setFeedback] = useState("")
  const [sent, setSent] = useState(false)
  // The card stays mounted across the decision (the poll fills in `result` on
  // the same block), so the fold reacts to that transition, not just to the
  // initial state. An explicit tap by the reader wins.
  const touched = useRef(false)
  useEffect(() => {
    if (!touched.current) setOpen(pending)
  }, [pending])
  const toggle = () => {
    touched.current = true
    setOpen((o) => !o)
  }
  const text = useMemo(() => planText(input), [input])
  const label = planStateLabel(state)
  if (!text) return null
  return (
    <View testID="plan-card" style={[styles.planCard, { borderColor: t.accent, backgroundColor: t.bg }]}>
      <TouchableOpacity style={styles.planHeader} onPress={toggle} activeOpacity={0.7}>
        <Icon name="sparkle" size={15} color={t.accent} />
        <Text style={[styles.planTitle, { color: t.accent }]}>
          Proposed plan{label ? ` · ${label}` : ""}
        </Text>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} color={t.accent} />
      </TouchableOpacity>
      {open ? (
        <View style={styles.planBody}>
          <Markdown text={text} color={t.text} selectable />
        </View>
      ) : null}
      {onDecide ? (
        denying ? (
          <View style={styles.planBody}>
            <TextInput
              testID="plan-feedback"
              style={[styles.ssInput, styles.ssMultiline]}
              value={feedback}
              onChangeText={setFeedback}
              placeholder="What should change? (sent to the agent to revise)"
              placeholderTextColor={t.textMuted}
              multiline
            />
            <View style={styles.permBtnRow}>
              <TouchableOpacity style={styles.permDeny} onPress={() => setDenying(false)} disabled={sent}>
                <Text style={styles.permDenyText}>Back</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="plan-send-feedback"
                style={styles.permAllow}
                onPress={() => { if (!sent) { setSent(true); onDecide("deny", feedback.trim()) } }}
                disabled={sent}
              >
                <Text style={styles.permAllowText}>Send feedback</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={[styles.permBtnRow, { marginHorizontal: 10, marginBottom: 10 }]}>
            <TouchableOpacity testID="plan-deny" style={styles.permDeny} onPress={() => setDenying(true)} disabled={sent}>
              <Text style={styles.permDenyText}>Request changes</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="plan-approve"
              style={styles.permAllow}
              onPress={() => { if (!sent) { setSent(true); onDecide("approve") } }}
              disabled={sent}
            >
              <Text style={styles.permAllowText}>{sent ? "…" : "Approve"}</Text>
            </TouchableOpacity>
          </View>
        )
      ) : null}
    </View>
  )
}
