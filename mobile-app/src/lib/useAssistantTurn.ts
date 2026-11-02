/**
 * useAssistantTurn — the voice-turn engine behind the CallKit Call screen.
 *
 * It owns the phase state machine, the last-heard / last-reply / error strings,
 * and the hands-free loop (`startHandsFree`/`stopHandsFree`). Utterances stream
 * to /api/voice/ws for STT, the text goes to the call brain (`POST
 * /api/call/turn`), and the answer is spoken: on LFM3-Audio the brain speaks
 * itself, segment by segment (callSegments.callStep), otherwise its text reply
 * goes through the TTS stream. The brain's
 * memory (`history`) lives here for the length of the call and is echoed back on
 * every turn. The first start asks GET /api/call/engine for the brain's model
 * name (or why no brain is configured — an error the caller sees).
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { api, type CallHistory } from "../api/client"
import {
  playCallAudio,
  prepareAudio,
  speak,
  startListening,
  stopListening,
  stopSpeaking,
  type ListenEvent,
} from "./voice"
import { startWakeguard, duplexAvailable, type DuplexMic } from "./duplexMic"
import { parseBargeTail } from "./bargeCommand"
import { callStep, joinSaid } from "./callSegments"
import { audioSession } from "./audioSessionNative"

// While the user speaks over Manager (before a command is confirmed), duck the TTS
// to this fraction of full volume so they can hear themselves. Restored to 1.0 on
// silence; a confirmed command halts playback entirely.
const DUCK_VOLUME = 0.25

// The voice loop's phases — each maps to a status line. "waiting" is the resting
// state of a connected call (listening for the next utterance); "connecting" is
// the first start asking the server for the call brain.
export type Phase = "idle" | "connecting" | "waiting" | "thinking" | "speaking" | "denied"

export interface UseAssistantTurn {
  phase: Phase
  /** The server's name for the call brain's model; null until the first start
   *  has asked. */
  model: string | null
  /** What the caller last said (transcribed). */
  heard: string
  /** What Manager last said back. */
  reply: string
  error: string
  /** Run one brain turn from already-transcribed text: ask the call brain, speak its reply. */
  runTurn: (text: string) => Promise<void>
  /** Begin listening (call start, or unmute). */
  startHandsFree: () => Promise<void>
  /** Pause listening (mute). */
  stopHandsFree: () => Promise<void>
}

export function useAssistantTurn(
  path: string | undefined,
  opts: { onEndCall?: () => void } = {}
): UseAssistantTurn {
  const [phase, setPhase] = useState<Phase>("idle")
  const [model, setModel] = useState<string | null>(null)
  const [heard, setHeard] = useState("")
  const [reply, setReply] = useState("")
  const [error, setError] = useState("")

  // The call brain's memory for this call: spoken turns plus the tool calls it
  // made. Opaque here; the server trims it.
  const historyRef = useRef<CallHistory>([])
  // The active listen-loop stopper, and a busy flag so an utterance that lands
  // while a turn is already running is ignored.
  const listenStopRef = useRef<null | (() => void)>(null)
  const busyRef = useRef(false)
  const handsFreeRef = useRef(false)
  // Barge-in: while speaking, a concurrent echo-cancelled wakeguard mic lets
  // "Manager stop / end the call / <new question>" interrupt playback. Kept in a
  // ref so the latest onEndCall is always reachable from the async speak.
  const onEndCallRef = useRef(opts.onEndCall)
  onEndCallRef.current = opts.onEndCall
  // Set when a barge-in requests a NEW turn mid-speech; picked up after playback
  // stops so we don't re-enter runTurn from inside itself.
  const bargeAskRef = useRef<string | null>(null)

  useEffect(() => {
    prepareAudio().then((ok) => !ok && setPhase("denied"))
    return () => {
      stopListening()
    }
  }, [])

  /**
   * Run `play` (the TTS stream), and — on a build with the native
   * AEC module — run a concurrent echo-cancelled "wakeguard" mic so the user can
   * barge in with "Manager …":
   *   - stop      → halt playback, settle to waiting (no new turn).
   *   - end       → halt playback and end the CallKit call (via onEndCall).
   *   - ask(tail) → halt playback and stash the new question for runTurn to pick up.
   * Falls back to plain playback without the native module.
   * Resolves true when a barge-in cut the playback short.
   */
  const playWithBargeIn = useCallback(async (play: () => Promise<void>): Promise<boolean> => {
    if (!duplexAvailable()) {
      await play()
      return false
    }
    let mic: DuplexMic | null = null
    let handled = false
    const teardown = async () => {
      const m = mic
      mic = null
      if (m) await m.stop().catch(() => {})
      // Always undo any active duck. onSpeechChange(false) is the only other
      // restore edge, and it won't fire if we tear down mid-speech — so without
      // this the TTS (and the NEXT utterance's sound) could stay stuck at 0.25.
      audioSession.setPlaybackVolume(1.0).catch(() => {})
    }
    try {
      mic = await startWakeguard(
        async (e) => {
          if (handled || !e.wake) return
          const cmd = parseBargeTail(e.text)
          handled = true
          await stopSpeaking().catch(() => {}) // interrupt playback now
          await teardown()
          if (cmd.kind === "end") {
            onEndCallRef.current?.()
          } else if (cmd.kind === "ask") {
            bargeAskRef.current = cmd.tail // runTurn re-enters after this speak
          }
          // "stop" needs no extra work: playback is already halted.
        },
        {
          speakerId: "default",
          // Duck Manager's TTS the instant the user starts talking — well before
          // the server round-trip confirms the wake word — so they can hear
          // themselves over it. Restore to full on silence (a false start that
          // wasn't a command). A real command halts playback entirely above.
          onSpeechChange: (speaking) => {
            if (handled) return
            audioSession.setPlaybackVolume(speaking ? DUCK_VOLUME : 1.0).catch(() => {})
          },
        }
      )
    } catch {
      mic = null // wakeguard unavailable — degrade to plain playback
    }
    try {
      await play()
    } finally {
      await teardown()
    }
    return handled
  }, [])

  const runTurn = useCallback(
    async (text: string): Promise<void> => {
      if (!text.trim() || !path) return
      setHeard(text)
      setError("")
      setPhase("thinking")
      try {
        let res = await api.callTurn({ path, text, history: historyRef.current })
        let shown = ""
        setReply("")
        for (;;) {
          historyRef.current = res.history
          shown = joinSaid(shown, res.said)
          setReply(shown)
          const step = callStep(res)
          if (step.kind === "done") break
          setPhase("speaking")
          if (step.kind === "speak") {
            setReply(joinSaid(shown, step.text))
            await playWithBargeIn(() => speak(step.text))
            break
          }
          // The brain is speaking itself: play this segment, then hand it back.
          // A barge-in tells the server to stop there and keep only what was said.
          const cut = await playWithBargeIn(() => playCallAudio(path, step.audio))
          if (!cut) setPhase("thinking")
          res = await api.callNext({ path, next: step.next, stop: cut })
          if (cut) {
            historyRef.current = res.history
            setReply(joinSaid(shown, res.said))
            break
          }
        }
        // Barge-in during playback may have asked a NEW question — run it now,
        // after this speak fully unwound (so we never re-enter from inside speak).
        const next = bargeAskRef.current
        bargeAskRef.current = null
        if (next) await runTurn(next)
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [path, playWithBargeIn]
  )

  /** Each window's verdict from the server: fire a turn on an utterance with
   *  words; ignore idle windows and anything while a turn is already running. */
  const onListenEvent = useCallback(
    async (e: ListenEvent) => {
      if (e.type !== "utterance" || !e.text.trim()) return
      if (busyRef.current) return
      busyRef.current = true
      // Pause listening while we run + speak the turn (mic and playback share the
      // one audio session); resume afterward if the call is still up.
      await stopListening()
      try {
        await runTurn(e.text)
      } finally {
        busyRef.current = false
        if (handsFreeRef.current) {
          setPhase("waiting")
          listenStopRef.current = await startListening(onListenEvent)
        } else {
          setPhase("idle")
        }
      }
    },
    [runTurn]
  )

  /** Begin listening. The first start asks the server for the call brain; later
   *  starts (unmute) skip that. */
  const startHandsFree = useCallback(async () => {
    if (!path) return
    setError("")
    handsFreeRef.current = true
    if (model === null) {
      setPhase("connecting")
      try {
        const brain = await api.callEngine()
        if (brain.error) throw new Error(brain.error)
        setModel(brain.model || "")
      } catch (e) {
        setError((e as Error).message)
        handsFreeRef.current = false
        setPhase("idle")
        return
      }
      if (!handsFreeRef.current) return
    }
    setPhase("waiting")
    listenStopRef.current = await startListening(onListenEvent)
  }, [path, model, onListenEvent])

  /** Pause listening and settle back to idle. */
  const stopHandsFree = useCallback(async () => {
    handsFreeRef.current = false
    listenStopRef.current = null
    await stopListening()
    if (!busyRef.current) setPhase("idle")
  }, [])

  return { phase, model, heard, reply, error, runTurn, startHandsFree, stopHandsFree }
}
