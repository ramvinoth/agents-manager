import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, Modal, SafeAreaView, ScrollView, Text, TextInput, View, useWindowDimensions } from "react-native"
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native"
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler"
import Animated, { Extrapolation, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated"
import { TouchableOpacity, useSeen } from "./Tracked"
import { api, type ChatStatus, type OpenDecision } from "../api/client"
import { answerBy, fmtWaiting, firstOpen, stepDecision } from "../lib/decisions"
import { commentPurpose, commentResolves, deckActions, deckSwipe, overscrollStep, verdictColumn, type Verdict } from "../lib/decisionDeck"
import { SNOOZE_OPTIONS } from "../lib/inbox"
import { useTheme } from "../lib/useTheme"
import { useStyles } from "../lib/styles"
import { recordSwipe } from "../lib/usageReporter"
import Icon from "./Icon"
import QuestionCard from "./QuestionCard"
import PlanCard from "./PlanCard"
import RedApprovalCard from "./RedApprovalCard"
import { resolveRed } from "../lib/redApproval"
import SheetModal from "./SheetModal"
import { userError } from "../lib/errors"
import { success, tap, warning } from "../lib/haptics"

const KIND_ICON: Record<OpenDecision["kind"], "help" | "file" | "shield" | "clipboard" | "warning"> = {
  question: "help",
  plan: "file",
  approval: "shield",
  card: "clipboard",
  red: "warning",
}
const KIND_LABEL: Record<OpenDecision["kind"], string> = {
  question: "Question",
  plan: "Plan approval",
  approval: "Tool approval",
  card: "Card for you",
  red: "Needs your OK",
}

const EDGE = 30 // px from the screen's left edge reserved for iOS's native swipe-back
const STAMP_AT = 110 // drag distance at which the APPROVE / DENY stamp is fully shown
const SPRING = { damping: 18, stiffness: 220 }

type Status = (Error & { status?: number }) | unknown
const alreadyDecided = (e: Status) => (e as { status?: number })?.status === 409

/**
 * DecisionCockpit — the decision deck. Every open decision across sessions is
 * a card the owner swipes: right approves, left denies, a pull past the top or
 * bottom of a card pages to the previous or next one, and round Deny / Comment
 * / Approve buttons do the same by tap (card #60 began it as a queue; the deck
 * makes it one-thumb). The rules live in lib/decisionDeck; this wires them up.
 *
 * The band hands it a FROZEN snapshot of the queue + the tapped index: the
 * board poll keeps running underneath but must not reshuffle the card under
 * the reader's thumb. A skipped item's durable row is untouched, so it
 * resurfaces next tick; "Postpone" snoozes its inbox row (d.inbox_id) so it is
 * hidden everywhere until the snooze lapses. Deferred, never dropped.
 *
 * Full cold-reader context per kind, from the RIGHT source:
 *  - question / plan → chatStatus(session) for the full options / plan text.
 *  - approval → the SECRET-SAFE preview the index already carries (d.summary);
 *    never chatStatus, whose raw tool input the index withholds on purpose.
 *  - card → the parked card's ask; a verdict moves it to its board's
 *    Approved / Declined column, a comment posts on its thread.
 *  - red → an org approval; approve asks once more inline (an Alert never
 *    presents inside a fullScreen Modal) before it runs.
 *
 * Deciding uses the EXISTING routes (race-safe via the decisions gate). A 409
 * ("already decided", e.g. another device won) is treated as resolved.
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
  const { width } = useWindowDimensions()
  const [idx, setIdx] = useState(startIndex)
  const resolved = useRef(new Set<number>()).current
  const [, redraw] = useState(0)
  const bump = () => redraw((n) => n + 1)
  const [status, setStatus] = useState<ChatStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const [postponing, setPostponing] = useState(false)
  const [commenting, setCommenting] = useState(false)
  const [draft, setDraft] = useState("")
  const [confirmRed, setConfirmRed] = useState(false)

  const len = decisions.length
  const d = decisions[idx]
  const needsStatus = d?.kind === "question" || d?.kind === "plan"
  const actions = d ? deckActions(d.kind) : { approve: false, deny: false, comment: false }
  // Each gesture reports on its own name, apart from the round buttons' taps.
  useSeen("swipe-deck-approve", undefined, actions.approve)
  useSeen("swipe-deck-deny", undefined, actions.deny)
  useSeen("swipe-deck-next", undefined, len > 1)
  useSeen("swipe-deck-prev", undefined, len > 1)
  // A message to the asking chat needs a chat to reach; an org approval with no
  // asking session can only be decided.
  const canComment = !!d && actions.comment && (commentResolves(d.kind) || !!d.session)

  // The card's horizontal travel, driven on the UI thread by the pan.
  const x = useSharedValue(0)

  // A fresh card starts centred, with no leftover message or confirm row.
  useEffect(() => {
    x.value = 0
    setNotice("")
    setConfirmRed(false)
    setDraft("")
  }, [idx])

  // Full content for question/plan comes from the durable row via chatStatus.
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
        if (alive) setLoadError(userError(e, "this item"))
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

  const postpone = useCallback(
    (hours: number) => {
      setPostponing(false)
      if (busy || !d || !d.inbox_id) return
      setBusy(true)
      api
        .inboxSnooze(d.inbox_id, hours)
        .then(() => goResolved())
        .catch((e) => setLoadError(userError(e, "this item", "postpone")))
        .finally(() => setBusy(false))
    },
    [busy, d, goResolved]
  )

  const step = useCallback(
    (dir: 1 | -1) => {
      const next = stepDecision(len, idx, dir, resolved)
      if (next !== idx) {
        tap()
        setIdx(next)
        bump()
      }
    },
    [idx, len, resolved]
  )

  // Run one decision call: resolved (or already decided elsewhere) → next
  // card; a failure brings the card back and says why.
  const settle = useCallback(
    (call: () => Promise<unknown>, what: string) => {
      setBusy(true)
      setLoadError("")
      call()
        .then(() => goResolved())
        .catch((e) => {
          if (alreadyDecided(e)) return goResolved()
          x.value = withSpring(0, SPRING)
          setLoadError(userError(e, what, "send"))
        })
        .finally(() => setBusy(false))
    },
    [goResolved]
  )

  /** Carry out a verdict on the current card (after the fly-out). */
  const commit = useCallback(
    (v: Verdict) => {
      if (!d) return
      v === "approve" ? success() : warning()
      if (d.kind === "approval" && d.id) {
        const id = d.id
        settle(() => api.chatPermissionDecide({ session: d.session, id, decision: v === "approve" ? "allow" : "deny" }), "your answer")
      } else if (d.kind === "plan") {
        settle(() => api.chatPlanDecide({ session: d.session, decision: v }), "your answer")
      } else if (d.kind === "red" && d.id) {
        const id = d.id
        settle(() => resolveRed(api.orgResolveApproval, id, v === "approve" ? "approved" : "denied"), "your answer")
      } else if (d.kind === "card" && d.card) {
        const card = d.card
        settle(async () => {
          const detail = await api.orgCard(card)
          const column = verdictColumn(detail.columns ?? [], v)
          if (column === null) {
            throw new Error(`This card's board has no ${v === "approve" ? "Approved" : "Declined"} column. Open the card to move it.`)
          }
          // The end of the column: a verdict joins the bottom of the pile.
          await api.orgMoveCard({ card_id: card, column_id: column, position: 9999 })
        }, "the card")
      } else {
        x.value = withSpring(0, SPRING)
      }
    },
    [d, settle]
  )

  /** A verdict from a swipe or a round button: fly the card off, then commit.
   *  An org approval asks once more before it runs, so the card returns and the
   *  confirm row shows instead. */
  const verdict = useCallback(
    (v: Verdict) => {
      if (busy || !d) return
      const allowed = v === "approve" ? actions.approve : actions.deny
      if (!allowed) {
        x.value = withSpring(0, SPRING)
        return
      }
      if (d.kind === "red" && v === "approve" && !confirmRed) {
        x.value = withSpring(0, SPRING)
        warning()
        setConfirmRed(true)
        return
      }
      if (v === "approve") recordSwipe("swipe-deck-approve")
      else recordSwipe("swipe-deck-deny")
      const off = (v === "approve" ? 1 : -1) * width * 1.5
      x.value = withTiming(off, { duration: 220 }, (done) => {
        if (done) runOnJS(commit)(v)
      })
    },
    [busy, d, actions.approve, actions.deny, confirmRed, width, commit]
  )

  // The gesture is memoized, so release through a ref to the latest verdict.
  const onReleaseRef = useRef<(dx: number, dy: number, vx: number) => void>(() => {})
  onReleaseRef.current = (dx, dy, vx) => {
    const v = deckSwipe({ dx, dy, vx })
    if (v) verdict(v)
    else x.value = withSpring(0, SPRING)
  }
  const release = (dx: number, dy: number, vx: number) => onReleaseRef.current(dx, dy, vx)

  const pan = useMemo(() => Gesture.Pan()
    // Claim only a decidedly sideways drag; vertical scroll passes to the card's
    // ScrollView. A touch at the screen edge is iOS's back swipe — never compete.
    .onTouchesDown((e, state) => {
      if (e.allTouches[0] && e.allTouches[0].absoluteX < EDGE) state.fail()
    })
    .activeOffsetX([-12, 12])
    .failOffsetY([-12, 12])
    .onUpdate((e) => {
      x.value = e.translationX
    })
    .onEnd((e) => {
      runOnJS(release)(e.translationX, e.translationY, e.velocityX)
    }), [])

  const cardStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value },
      { rotate: `${interpolate(x.value, [-width, 0, width], [-12, 0, 12], Extrapolation.CLAMP)}deg` },
    ],
  }))
  const approveStamp = useAnimatedStyle(() => ({ opacity: interpolate(x.value, [0, STAMP_AT], [0, 1], Extrapolation.CLAMP) }))
  const denyStamp = useAnimatedStyle(() => ({ opacity: interpolate(x.value, [-STAMP_AT, 0], [1, 0], Extrapolation.CLAMP) }))

  /** A pull past the card's top or bottom edge pages the deck. */
  const onScrollEndDrag = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
      const dir = overscrollStep({ offsetY: contentOffset.y, contentH: contentSize.height, viewH: layoutMeasurement.height })
      if (!dir) return
      if (dir === "next") recordSwipe("swipe-deck-next")
      else recordSwipe("swipe-deck-prev")
      step(dir === "next" ? 1 : -1)
    },
    [step]
  )

  const answerQuestion = useCallback(
    (picks: string[], note: string) => {
      if (busy || !d) return
      success()
      settle(() => api.chatQuestionAnswer({ session: d.session, picks, note }), "your answer")
    },
    [busy, d, settle]
  )

  const sendComment = useCallback(() => {
    const body = draft.trim()
    if (busy || !d || !body) return
    setCommenting(false)
    if (d.kind === "question") {
      settle(() => api.chatQuestionAnswer({ session: d.session, picks: [], note: body }), "your answer")
    } else if (d.kind === "plan") {
      settle(() => api.chatPlanDecide({ session: d.session, decision: "deny", feedback: body }), "your notes")
    } else if (d.kind === "card" && d.card) {
      const card = d.card
      settle(() => api.orgAddCardComment({ card_id: card, body }), "your comment")
    } else {
      // A tool or org approval stays open: the message only reaches the chat.
      setBusy(true)
      api
        .inboxSend({ to: `session:${d.session}`, body })
        .then(() => {
          setDraft("")
          setNotice("Sent to the agent. The decision is still open.")
        })
        .catch((e) => setLoadError(userError(e, "your message", "send")))
        .finally(() => setBusy(false))
    }
  }, [busy, d, draft, settle])

  const who = useMemo(() => (d ? d.label || d.session.slice(0, 8) : ""), [d])
  const openCount = len - resolved.size
  const purpose = d ? commentPurpose(d.kind) : null

  if (!d) {
    // Everything got resolved while open (or an empty snapshot slipped through).
    return (
      <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
        <SafeAreaView testID="decision-cockpit" style={styles.dcCaughtUp}>
          <Icon name="check" size={28} color={t.accent} />
          <Text style={styles.dcCaughtUpText}>All caught up</Text>
          <TouchableOpacity testID="cockpit-done" onPress={onClose} style={[styles.permAllow, styles.dcDoneBtn]}>
            <Text style={styles.permAllowText}>Done</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </Modal>
    )
  }

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      {/* A Modal is its own native root: gestures inside need their own handler root. */}
      <GestureHandlerRootView style={styles.flex1}>
        <SafeAreaView testID="decision-cockpit" style={styles.page}>
          {/* Header: who is asking, what kind, how long they've waited, close. */}
          <View style={styles.dcHeader}>
            <Icon name={KIND_ICON[d.kind] || "help"} size={18} color={t.accent} />
            <View style={styles.flex1}>
              <Text style={styles.dcWho} numberOfLines={1}>
                {who}
                {d.host !== "local" ? ` · ${d.host}` : ""}
              </Text>
              <Text style={styles.dcSub} numberOfLines={1}>
                {KIND_LABEL[d.kind]} · waited {fmtWaiting(d.waiting_s)}
              </Text>
            </View>
            <Text testID="cockpit-count" style={styles.dcCount}>
              {openCount} open
            </Text>
            <TouchableOpacity testID="cockpit-close" onPress={onClose} disabled={busy} style={styles.dcCloseBtn}>
              <Icon name="close" size={20} color={t.textMuted} />
            </TouchableOpacity>
          </View>

          <View style={styles.deckStage}>
            <GestureDetector gesture={pan}>
              <Animated.View testID="deck-card" style={[styles.deckCard, cardStyle]}>
                <Animated.View pointerEvents="none" style={[styles.deckStamp, styles.deckStampApprove, approveStamp]}>
                  <Text style={[styles.deckStampText, { color: t.success }]}>{d.kind === "approval" ? "ALLOW" : "APPROVE"}</Text>
                </Animated.View>
                <Animated.View pointerEvents="none" style={[styles.deckStamp, styles.deckStampDeny, denyStamp]}>
                  <Text style={[styles.deckStampText, { color: t.danger }]}>DENY</Text>
                </Animated.View>
                <ScrollView
                  key={idx}
                  style={styles.flex1}
                  contentContainerStyle={styles.dcScrollContent}
                  keyboardShouldPersistTaps="handled"
                  alwaysBounceVertical
                  onScrollEndDrag={onScrollEndDrag}
                >
                  {/* The index's one-line summary is the cold-reader headline —
                      shown before the full content loads. */}
                  <Text style={styles.dcSummary}>{d.summary || "(no summary)"}</Text>

                  {loading ? <ActivityIndicator color={t.accent} /> : null}
                  {loadError ? (
                    <Text testID="cockpit-error" style={[styles.sheetHint, { color: t.danger }]}>
                      {loadError}
                    </Text>
                  ) : null}
                  {notice ? <Text testID="deck-notice" style={styles.sheetHint}>{notice}</Text> : null}

                  {d.kind === "question" ? (
                    status?.pending_question ? (
                      <QuestionCard input={status.pending_question.questions} onAnswer={answerQuestion} />
                    ) : !loading && !loadError ? (
                      <ResolvedElsewhere styles={styles} onOpen={() => onOpenThread(d)} />
                    ) : null
                  ) : null}

                  {d.kind === "plan" ? (
                    status?.pending_plan ? (
                      <PlanCard input={status.pending_plan.plan} />
                    ) : !loading && !loadError ? (
                      <ResolvedElsewhere styles={styles} onOpen={() => onOpenThread(d)} />
                    ) : null
                  ) : null}

                  {d.kind === "approval" ? (
                    <View testID="cockpit-approval" style={styles.permCard}>
                      <Text style={styles.permTitle}>Allow tool: {d.tool_name || "tool"}?</Text>
                      <Text style={styles.permInput}>{d.summary || "(no preview)"}</Text>
                    </View>
                  ) : null}

                  {d.kind === "red" ? <RedApprovalCard testID="cockpit-red" ask={d} /> : null}

                  {d.kind === "card" ? (
                    <View testID="cockpit-card" style={styles.permCard}>
                      <Text style={styles.permTitle}>{d.column ? `Parked in ${d.column}` : "Parked for you"}</Text>
                      {d.ask ? <Text testID="cockpit-card-ask" style={styles.permInput}>{d.ask}</Text> : null}
                      {answerBy(d.expires_at, Date.now()) ? (
                        <Text testID="cockpit-card-deadline" style={[styles.permInput, { color: t.danger }]}>{answerBy(d.expires_at, Date.now())}</Text>
                      ) : null}
                      <Text style={styles.permInput}>Approve or deny moves the card to Approved or Declined. Open it to read the full thread.</Text>
                      <TouchableOpacity testID="cockpit-card-open" style={styles.dcOpenChat} onPress={() => d.card && onOpenCard(d.card)} disabled={busy}>
                        <Text style={styles.dcOpenChatText}>Open card</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}

                  {/* Need the whole conversation before deciding? Leaves it open. */}
                  {d.kind !== "card" && d.session ? (
                    <TouchableOpacity testID="cockpit-open-chat" onPress={() => onOpenThread(d)} style={styles.dcOpenChat}>
                      <Text style={styles.dcOpenChatText}>Open chat to see the full thread</Text>
                    </TouchableOpacity>
                  ) : null}

                  <Text style={styles.deckHint}>
                    {actions.approve ? "Swipe right to approve, left to deny. " : "Answer above, or reply with the comment button. "}
                    Pull past the top or bottom for the previous or next one.
                  </Text>
                </ScrollView>
              </Animated.View>
            </GestureDetector>
          </View>

          {/* An org approval asks once more before it runs. */}
          {confirmRed ? (
            <View testID="deck-red-confirm" style={styles.deckConfirm}>
              <Text style={styles.deckConfirmText}>Approve it? {d.risk || "The action runs."}</Text>
              <View style={styles.permBtnRow}>
                <TouchableOpacity testID="deck-red-cancel" style={styles.permDeny} onPress={() => setConfirmRed(false)} disabled={busy}>
                  <Text style={styles.permDenyText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity testID="deck-red-confirm-approve" style={styles.permAllow} onPress={() => verdict("approve")} disabled={busy}>
                  <Text style={styles.permAllowText}>Yes, approve</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}

          {/* The round buttons: the same verdicts as the swipe, by tap. */}
          <View style={styles.deckButtons}>
            <TouchableOpacity testID="deck-deny" onPress={() => verdict("deny")} disabled={busy || !actions.deny}
              style={[styles.deckRound, { borderColor: t.danger }, !actions.deny && styles.deckRoundOff]}>
              <Icon name="close" size={30} color={t.danger} />
            </TouchableOpacity>
            <TouchableOpacity testID="deck-comment" onPress={() => setCommenting(true)} disabled={busy || !canComment}
              style={[styles.deckRound, styles.deckRoundSmall, { borderColor: t.accent }, !canComment && styles.deckRoundOff]}>
              <Icon name="chat" size={22} color={t.accent} />
            </TouchableOpacity>
            <TouchableOpacity testID="deck-approve" onPress={() => verdict("approve")} disabled={busy || !actions.approve}
              style={[styles.deckRound, { borderColor: t.success }, !actions.approve && styles.deckRoundOff]}>
              <Icon name="check" size={30} color={t.success} />
            </TouchableOpacity>
          </View>

          {/* Footer: browse, skip, postpone. Skip leaves the row durable → it
              comes back next tick; Postpone snoozes it until the snooze lapses.
              An item with no inbox row cannot be snoozed — only skipped. */}
          <View style={styles.dcFooter}>
            <TouchableOpacity testID="cockpit-prev" onPress={() => step(-1)} disabled={busy} style={[styles.permDeny, styles.dcNavBtn]}>
              <Icon name="chevronLeft" size={16} color={t.text} />
            </TouchableOpacity>
            <TouchableOpacity testID="cockpit-skip" onPress={skip} disabled={busy} style={[styles.permDeny, styles.dcSkipBtn]}>
              <Text style={styles.permDenyText}>Skip</Text>
            </TouchableOpacity>
            {d.inbox_id ? (
              <TouchableOpacity testID="cockpit-postpone" onPress={() => setPostponing(true)} disabled={busy} style={[styles.permDeny, styles.dcSkipBtn]}>
                <Text style={styles.permDenyText}>Postpone</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity testID="cockpit-next" onPress={() => step(1)} disabled={busy} style={[styles.permDeny, styles.dcNavBtn]}>
              <Icon name="chevronRight" size={16} color={t.text} />
            </TouchableOpacity>
          </View>

          <SheetModal visible={postponing} onClose={() => setPostponing(false)}>
            <Text style={styles.sheetTitle}>Postpone — bring it back in</Text>
            {SNOOZE_OPTIONS.map((o) => (
              <TouchableOpacity key={o.hours} testID={`cockpit-postpone-${o.hours}`} onPress={() => postpone(o.hours)}
                style={styles.dcSnoozeItem}>
                <Text style={styles.dcSnoozeLabel}>{o.label}</Text>
              </TouchableOpacity>
            ))}
            <Text style={styles.dcSnoozeHint}>
              Hidden from the Inbox and the board until then — never dropped.
            </Text>
          </SheetModal>

          <SheetModal visible={commenting} onClose={() => setCommenting(false)}>
            <Text style={styles.sheetTitle}>{purpose?.title}</Text>
            <Text style={styles.dcSnoozeHint}>{purpose?.hint}</Text>
            <TextInput
              testID="deck-comment-input"
              value={draft}
              onChangeText={setDraft}
              placeholder="Write it here"
              placeholderTextColor={t.textMuted}
              multiline
              autoFocus
              style={[styles.ssInput, styles.ssMultiline]}
            />
            <TouchableOpacity testID="deck-comment-send" onPress={sendComment} disabled={busy || !draft.trim()}
              style={[styles.permAllow, styles.deckSend, !draft.trim() && styles.deckRoundOff]}>
              <Text style={styles.permAllowText}>{purpose?.send}</Text>
            </TouchableOpacity>
          </SheetModal>
        </SafeAreaView>
      </GestureHandlerRootView>
    </Modal>
  )
}

/** A question/plan whose durable row is no longer there (decided on another
 *  device, or the row lives on a host this viewer can't read live): we have the
 *  summary but not the full content. Offer the thread rather than a stale card. */
function ResolvedElsewhere({ styles, onOpen }: { styles: ReturnType<typeof useStyles>; onOpen: () => void }) {
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
