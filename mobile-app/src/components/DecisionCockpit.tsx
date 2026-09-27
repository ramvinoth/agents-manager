import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, Modal, SafeAreaView, ScrollView, Text, TouchableOpacity, View } from "react-native"
import { api, type ChatStatus, type OpenDecision } from "../api/client"
import { fmtWaiting, firstOpen, stepDecision } from "../lib/decisions"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../screens/styles"
import Icon from "./Icon"
import QuestionCard from "./QuestionCard"
import PlanCard from "./PlanCard"

const KIND_ICON: Record<OpenDecision["kind"], "help" | "file" | "shield" | "clipboard"> = {
  question: "help",
  plan: "file",
  approval: "shield",
  card: "clipboard",
}
const KIND_LABEL: Record<OpenDecision["kind"], string> = {
  question: "Question",
  plan: "Plan approval",
  approval: "Tool approval",
  card: "Card for you",
}

/**
 * DecisionCockpit — decide the cross-session queue IN PLACE, one item at a time,
 * without leaving the board (card #60, Ram's big-vision ask). The band hands it
 * a FROZEN snapshot of the queue + the tapped index; the 4s board poll keeps
 * running underneath but must NOT reshuffle the item under the reader's thumb,
 * so the cockpit walks its own copy. New items simply appear on the next open;
 * a skipped item's durable row is untouched, so it resurfaces next tick.
 *
 * Full cold-reader context per kind, from the RIGHT source:
 *  - question / plan → the human-facing content the index truncates to 120 chars
 *    lives in the durable row; fetch chatStatus(session) on demand for the full
 *    options / plan markdown (no secrets — this is meant-for-human text).
 *  - approval → render the SECRET-SAFE preview the index already carries
 *    (d.summary). We deliberately do NOT fetch chatStatus for approvals: that
 *    route returns RAW tool input, which the cross-session index withholds on
 *    purpose. To see raw input, open the owning chat (you're in-context there).
 *  - card → the card IS the decision surface; open it on the board.
 *
 * Deciding uses the EXISTING per-session routes (race-safe via the decisions
 * gate) — the board never becomes a second approval store. A 409 ("already
 * decided", e.g. another device won) is treated as resolved, not an error.
 */
export default function DecisionCockpit({
  decisions,
  startIndex,
  onClose,
  onResolved,
  onOpenThread,
  onOpenCard,
}: {
  decisions: OpenDecision[]
  startIndex: number
  onClose: () => void
  onResolved: () => void
  onOpenThread: (d: OpenDecision) => void
  onOpenCard: (cardId: number) => void
}) {
  const t = useTheme()
  const styles = useStyles()
  const [idx, setIdx] = useState(startIndex)
  const resolved = useRef(new Set<number>()).current
  const [, redraw] = useState(0)
  const bump = () => redraw((n) => n + 1)
  const [status, setStatus] = useState<ChatStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState("")
  const [busy, setBusy] = useState(false)

  const len = decisions.length
  const d = decisions[idx]
  const needsStatus = d?.kind === "question" || d?.kind === "plan"

  // Full content for question/plan comes from the durable row via chatStatus.
  // Approvals render from the secret-safe preview already in `d`; cards open on
  // the board — neither fetches.
  useEffect(() => {
    if (!d || !needsStatus) {
      setStatus(null)
      setLoadError("")
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    setLoadError("")
    setStatus(null)
    api
      .chatStatus(d.session)
      .then((s) => {
        if (alive) setStatus(s)
      })
      .catch((e) => {
        if (alive) setLoadError((e as Error).message || "Could not load this item.")
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [d?.session, d?.kind, needsStatus, idx])

  const goResolved = useCallback(() => {
    resolved.add(idx)
    const next = firstOpen(len, idx, resolved)
    if (next < 0) {
      onResolved()
      onClose()
      return
    }
    setIdx(next)
    bump()
    onResolved() // refresh the board's queue behind us
  }, [idx, len, resolved, onResolved, onClose])

  const skip = useCallback(() => {
    // Not deciding this now: leave the durable row untouched (it resurfaces next
    // tick) and move to the next OPEN item. Nothing left → close.
    const next = stepDecision(len, idx, 1, resolved)
    if (next === idx) {
      onClose()
      return
    }
    setIdx(next)
    bump()
  }, [idx, len, resolved, onClose])

  const step = (dir: 1 | -1) => {
    const next = stepDecision(len, idx, dir, resolved)
    if (next !== idx) {
      setIdx(next)
      bump()
    }
  }

  const answerQuestion = useCallback(
    (picks: string[], note: string) => {
      if (busy || !d) return
      setBusy(true)
      api
        .chatQuestionAnswer({ session: d.session, picks, note })
        .then(() => goResolved())
        .catch((e) => {
          // 409 = already answered elsewhere → it's resolved, advance.
          if ((e as Error & { status?: number }).status === 409) goResolved()
          else setLoadError((e as Error).message)
        })
        .finally(() => setBusy(false))
    },
    [busy, d, goResolved]
  )

  const decidePlan = useCallback(
    (decision: "approve" | "deny", feedback?: string) => {
      if (busy || !d) return
      setBusy(true)
      api
        .chatPlanDecide({ session: d.session, decision, feedback })
        .then(() => goResolved())
        .catch((e) => {
          if ((e as Error & { status?: number }).status === 409) goResolved()
          else setLoadError((e as Error).message)
        })
        .finally(() => setBusy(false))
    },
    [busy, d, goResolved]
  )

  const decideApproval = useCallback(
    (decision: "allow" | "deny") => {
      if (busy || !d || !d.id) return
      setBusy(true)
      api
        .chatPermissionDecide({ session: d.session, id: d.id, decision })
        .then(() => goResolved())
        .catch((e) => {
          if ((e as Error & { status?: number }).status === 409) goResolved()
          else setLoadError((e as Error).message)
        })
        .finally(() => setBusy(false))
    },
    [busy, d, goResolved]
  )

  const who = useMemo(() => (d ? d.label || d.session.slice(0, 8) : ""), [d])
  const openCount = len - resolved.size

  if (!d) {
    // Everything got resolved while open (or an empty snapshot slipped through).
    return (
      <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
        <SafeAreaView testID="decision-cockpit" style={{ flex: 1, backgroundColor: t.bg, alignItems: "center", justifyContent: "center", gap: 12 }}>
          <Icon name="check" size={28} color={t.accent} />
          <Text style={{ color: t.text, fontWeight: "700" }}>All caught up</Text>
          <TouchableOpacity testID="cockpit-done" onPress={onClose} style={[styles.permAllow, { marginLeft: 0 }]}>
            <Text style={styles.permAllowText}>Done</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </Modal>
    )
  }

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaView testID="decision-cockpit" style={{ flex: 1, backgroundColor: t.bg }}>
        {/* Header: who is asking, what kind, how long they've waited, close. */}
        <View style={{ flexDirection: "row", alignItems: "center", padding: 12, gap: 10, borderBottomWidth: 1, borderBottomColor: t.border }}>
          <Icon name={KIND_ICON[d.kind] || "help"} size={18} color={t.accent} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontWeight: "700", fontSize: 14 }} numberOfLines={1}>
              {who}
              {d.host !== "local" ? ` · ${d.host}` : ""}
            </Text>
            <Text style={{ color: t.textMuted, fontSize: 12 }} numberOfLines={1}>
              {KIND_LABEL[d.kind]} · waited {fmtWaiting(d.waiting_s)}
            </Text>
          </View>
          <Text testID="cockpit-count" style={{ color: t.textMuted, fontSize: 12, flexShrink: 0 }}>
            {openCount} open
          </Text>
          <TouchableOpacity testID="cockpit-close" onPress={onClose} disabled={busy} style={{ padding: 6 }}>
            <Icon name="close" size={20} color={t.textMuted} />
          </TouchableOpacity>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 10 }} keyboardShouldPersistTaps="handled">
          {/* The index's one-line summary is the cold-reader headline — always
              shown, even before the full content loads, so the reader has
              context immediately. */}
          <Text style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>{d.summary || "(no summary)"}</Text>

          {loading ? <ActivityIndicator color={t.accent} /> : null}
          {loadError ? (
            <Text testID="cockpit-error" style={[styles.sheetHint, { color: t.danger }]}>
              {loadError}
            </Text>
          ) : null}

          {d.kind === "question" ? (
            status?.pending_question ? (
              <QuestionCard input={status.pending_question.questions} onAnswer={answerQuestion} />
            ) : !loading && !loadError ? (
              <ResolvedElsewhere t={t} styles={styles} onOpen={() => onOpenThread(d)} />
            ) : null
          ) : null}

          {d.kind === "plan" ? (
            status?.pending_plan ? (
              <PlanCard input={status.pending_plan.plan} onDecide={decidePlan} />
            ) : !loading && !loadError ? (
              <ResolvedElsewhere t={t} styles={styles} onOpen={() => onOpenThread(d)} />
            ) : null
          ) : null}

          {d.kind === "approval" ? (
            <View testID="cockpit-approval" style={styles.permCard}>
              <Text style={styles.permTitle}>Allow tool: {d.tool_name || "tool"}?</Text>
              <Text style={styles.permInput}>{d.summary || "(no preview)"}</Text>
              <View style={styles.permBtnRow}>
                <TouchableOpacity testID="cockpit-approval-deny" style={styles.permDeny} onPress={() => decideApproval("deny")} disabled={busy}>
                  <Text style={styles.permDenyText}>Deny</Text>
                </TouchableOpacity>
                <TouchableOpacity testID="cockpit-approval-allow" style={styles.permAllow} onPress={() => decideApproval("allow")} disabled={busy}>
                  <Text style={styles.permAllowText}>Allow</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}

          {d.kind === "card" ? (
            <View testID="cockpit-card" style={styles.permCard}>
              <Text style={styles.permTitle}>{d.column ? `Parked in ${d.column}` : "Parked for you"}</Text>
              <Text style={styles.permInput}>Open the card to read the full context and move it to Approved or Declined.</Text>
              <View style={styles.permBtnRow}>
                <TouchableOpacity testID="cockpit-card-open" style={styles.permAllow} onPress={() => d.card && onOpenCard(d.card)} disabled={busy}>
                  <Text style={styles.permAllowText}>Open card</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}

          {/* Review-needed / need-the-full-thread escape hatch. For every kind:
              go see the whole conversation before deciding. Leaves the item
              open (it resurfaces). */}
          {d.kind !== "card" ? (
            <TouchableOpacity testID="cockpit-open-chat" onPress={() => onOpenThread(d)} style={{ padding: 12, alignItems: "center" }}>
              <Text style={{ color: t.accent, fontWeight: "600" }}>Open chat to see the full thread</Text>
            </TouchableOpacity>
          ) : null}
        </ScrollView>

        {/* Footer: browse (‹ ›) and skip. Skip leaves the row durable → it comes
            back next tick; ‹ › browse without acting, no wrap. */}
        <View style={{ flexDirection: "row", alignItems: "center", padding: 12, gap: 10, borderTopWidth: 1, borderTopColor: t.border }}>
          <TouchableOpacity testID="cockpit-prev" onPress={() => step(-1)} disabled={busy} style={[styles.permDeny, { marginLeft: 0, flexDirection: "row", alignItems: "center", gap: 4 }]}>
            <Icon name="chevronLeft" size={16} color={t.text} />
            <Text style={styles.permDenyText}>Prev</Text>
          </TouchableOpacity>
          <TouchableOpacity testID="cockpit-skip" onPress={skip} disabled={busy} style={[styles.permDeny, { flex: 1, marginLeft: 0, alignItems: "center" }]}>
            <Text style={styles.permDenyText}>Skip for now</Text>
          </TouchableOpacity>
          <TouchableOpacity testID="cockpit-next" onPress={() => step(1)} disabled={busy} style={[styles.permDeny, { marginLeft: 0, flexDirection: "row", alignItems: "center", gap: 4 }]}>
            <Text style={styles.permDenyText}>Next</Text>
            <Icon name="chevronRight" size={16} color={t.text} />
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </Modal>
  )
}

/** A question/plan whose durable row is no longer there (decided on another
 *  device, or the row lives on a host this viewer can't read live): we have the
 *  summary but not the full content. Offer the thread rather than a stale card. */
function ResolvedElsewhere({ t, styles, onOpen }: { t: ReturnType<typeof useTheme>; styles: ReturnType<typeof useStyles>; onOpen: () => void }) {
  return (
    <View testID="cockpit-unavailable" style={styles.permCard}>
      <Text style={styles.permTitle}>Full details aren't loadable here</Text>
      <Text style={styles.permInput}>It may already be answered, or the session lives on another machine. Open the chat to decide, or skip — it stays in the queue until it's handled.</Text>
      <View style={styles.permBtnRow}>
        <TouchableOpacity style={styles.permAllow} onPress={onOpen}>
          <Text style={styles.permAllowText}>Open chat</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}
