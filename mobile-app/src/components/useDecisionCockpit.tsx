import React, { useCallback, useState } from "react"
import type { NativeStackNavigationProp } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { type OpenDecision } from "../api/client"
import DecisionCockpit from "./DecisionCockpit"

/**
 * The ONE place a decision is made, hosted by every surface that lists them
 * (the board's band, the Inbox's "Needs you" band and decision bubbles). A
 * surface calls `open(snapshot, index)` with the queue as it stands at the tap
 * — FROZEN, so a poll underneath can't shift the item under the reader's thumb
 * — and renders `element`. The escape hatches (open the owning chat / card)
 * live here once, so the surfaces can't drift apart.
 *
 * `guard` lets a screen veto navigation after it lost its scope (the board
 * switches projects under an in-flight tap); `onResolved` re-reads the
 * host surface's list after a decision.
 */
export function useDecisionCockpit(
  navigation: NativeStackNavigationProp<RootStackParamList, keyof RootStackParamList>,
  { onResolved, guard = () => true }: { onResolved: () => void; guard?: () => boolean },
) {
  const [state, setState] = useState<{ snapshot: OpenDecision[]; index: number } | null>(null)

  const open = useCallback((snapshot: OpenDecision[], index: number) => {
    if (guard() && snapshot.length) setState({ snapshot: snapshot.slice(), index: Math.max(0, Math.min(index, snapshot.length - 1)) })
  }, [guard])
  const close = useCallback(() => setState(null), [])

  const openCard = useCallback((id: number) => {
    if (!guard()) return
    setState(null)
    navigation.navigate("CardDetail", { id })
  }, [navigation, guard])

  // Review-needed: jump to the session that owns the decision. The Thread opens
  // at once on the session id and resolves its transcript itself (a gone chat
  // explains itself there); the item stays in the queue either way.
  const openThread = useCallback((d: OpenDecision) => {
    if (!guard()) return
    setState(null)
    navigation.navigate("Thread", { host: d.host || "local", label: d.label || d.session.slice(0, 8), session: d.session })
  }, [navigation, guard])

  const element = state ? (
    <DecisionCockpit
      decisions={state.snapshot}
      startIndex={state.index}
      onClose={close}
      onResolved={onResolved}
      onOpenThread={openThread}
      onOpenCard={openCard}
    />
  ) : null
  return { open, close, openCard, element }
}
