/**
 * CallProvider — owns the one live voice call, above the navigator, so it
 * survives screen changes. The Call screen is only a view of this; minimizing
 * it (or navigating anywhere) leaves the call running, and the in-call pill
 * brings you back. Ending happens only through hangUp (End button, CallKit /
 * lock screen, or the spoken "end the call").
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { callManager } from "./callManager"
import { callSession } from "./callSession"
import { useAssistantTurn } from "./useAssistantTurn"
import { stopSpeaking } from "./voice"

type Turn = ReturnType<typeof useAssistantTurn>

interface CallApi extends Pick<Turn, "phase" | "model" | "heard" | "reply" | "error"> {
  active: boolean
  label: string
  muted: boolean
  elapsed: number
  /** Join the live call, or start one when none is running. */
  join: (label: string, path: string | undefined) => void
  hangUp: () => void
  toggleMute: () => void
}

const CallContext = createContext<CallApi | null>(null)

export function useCall(): CallApi {
  const c = useContext(CallContext)
  if (!c) throw new Error("useCall outside CallProvider")
  return c
}

export function CallProvider({ children }: { children: React.ReactNode }) {
  const session = useSyncExternalStore(callSession.subscribe, callSession.get)
  const hangUpRef = useRef<() => void>(() => {})
  const turn = useAssistantTurn(session.path, { onEndCall: () => hangUpRef.current() })
  const { startHandsFree, stopHandsFree } = turn
  const [muted, setMuted] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const endingRef = useRef(false)

  const hangUp = useCallback(async () => {
    if (!callSession.get().active || endingRef.current) return
    endingRef.current = true
    await stopHandsFree()
    await stopSpeaking().catch(() => {})
    callManager.endCall()
    setMuted(false)
    callSession.end()
    endingRef.current = false
  }, [stopHandsFree])
  hangUpRef.current = hangUp

  // CallKit + listen loop run for exactly as long as the session is active.
  useEffect(() => {
    if (!session.active) return
    let cancelled = false
    setElapsed(0)
    ;(async () => {
      await callManager.startCall(session.label, { onEnd: () => hangUpRef.current(), onMuted: setMuted })
      if (!cancelled) await startHandsFree()
    })()
    const tick = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => { cancelled = true; clearInterval(tick) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.active])

  const toggleMute = useCallback(() => {
    const next = !muted
    setMuted(next)
    callManager.setMuted(next)
    if (next) stopHandsFree()
    else startHandsFree()
  }, [muted, startHandsFree, stopHandsFree])

  const join = useCallback((label: string, path: string | undefined) => { callSession.start(label, path) }, [])

  const value = useMemo<CallApi>(() => ({
    phase: turn.phase, model: turn.model, heard: turn.heard, reply: turn.reply, error: turn.error,
    active: session.active, label: session.label, muted, elapsed, join, hangUp, toggleMute,
  }), [turn.phase, turn.model, turn.heard, turn.reply, turn.error, session.active, session.label, muted, elapsed, join, hangUp, toggleMute])

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>
}
