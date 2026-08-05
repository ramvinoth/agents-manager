/**
 * useAssistantTurn — the shared voice-turn engine behind both the push-to-talk
 * Voice screen and the CallKit Call screen.
 *
 * It owns everything that is identical between the two: the phase state machine,
 * the last-heard / last-reply / error strings, running one turn from transcribed
 * text (`runTurn`), the hands-free wake-word listen loop
 * (`startHandsFree`/`stopHandsFree`), and voice enrollment. The screens layer
 * their own UI (and, for Voice, push-to-talk) on top.
 *
 * `setPhase` is exposed because the Voice screen's push-to-talk drives the phase
 * directly; CallScreen only uses the hands-free loop.
 *
 * Pass `callMode: true` (the Call screen) to drop the per-turn wake word and run the
 * full Claude harness (session's provider/model/mode) spoken via Pocket. The Voice
 * screen leaves it off and honors the persisted "Assistant voice" appliance toggle.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../api/client"
import { groupThread, parseTranscript, type ExchangeItem } from "./thread"
import {
  enrollVoice,
  isAssistantVoice,
  isEnrolled,
  prepareAudio,
  speak,
  startListening,
  stopListening,
  stopSpeaking,
  type ListenEvent,
} from "./voice"
import { startWakeguard, duplexAvailable, type DuplexMic } from "./duplexMic"
import { parseBargeTail } from "./bargeCommand"
import { audioSession } from "./audioSessionNative"
import { composerPrefs } from "../state/config"

// While the user speaks over Harman (before a command is confirmed), duck the TTS
// to this fraction of full volume so they can hear themselves. Restored to 1.0 on
// silence; a confirmed command halts playback entirely.
const DUCK_VOLUME = 0.25

// The voice loop's phases — each maps to a status line (and, in Voice, a mic
// state). "waiting" is the hands-free resting state (listening for the wake word).
export type Phase = "idle" | "listening" | "waiting" | "thinking" | "speaking" | "denied"

export interface UseAssistantTurn {
  phase: Phase
  setPhase: (p: Phase) => void
  heard: string
  setHeard: (s: string) => void
  reply: string
  /** The whole last exchange (steps/plan/finalText) for chat-style rendering, or
   *  null when there's no harness turn yet (or the assistant-appliance path). */
  replyItem: ExchangeItem | null
  error: string
  setError: (s: string) => void
  /** Run one turn from already-transcribed text: send it into the chat pipeline
   *  (or the assistant one-shot), await the reply, and speak it. */
  runTurn: (text: string) => Promise<void>
  startHandsFree: () => Promise<void>
  stopHandsFree: () => Promise<void>
  enrolled: boolean
  enrolling: boolean
  onEnroll: () => Promise<void>
  assistantVoice: boolean
  setAssistantVoicePref: (on: boolean) => void
}

export function useAssistantTurn(
  host: string,
  path: string | undefined,
  opts: { callMode?: boolean; onEndCall?: () => void } = {}
): UseAssistantTurn {
  const [phase, setPhase] = useState<Phase>("idle")
  const [heard, setHeard] = useState("")
  const [reply, setReply] = useState("")
  // The whole last exchange (final text + tool steps + plan) so the voice screen
  // can render it chat-style — tools, plan cards, and markdown — not just prose.
  const [replyItem, setReplyItem] = useState<ExchangeItem | null>(null)
  const [error, setError] = useState("")
  const [enrolled, setEnrolled] = useState(false)
  const [enrolling, setEnrolling] = useState(false)
  const [assistantVoice, setAssistantVoiceState] = useState(false)

  // Assistant appliance: answer + speak the utterance via the :8099 service (Qwen +
  // 2 tools) in one fast stream, bypassing the chat pipeline. This is the Voice
  // screen's "Assistant voice" toggle — a snappy Q&A path. A CALL does NOT use it:
  // a call runs the full Claude harness (session's provider/model/mode) and speaks
  // the reply via Pocket, so it's as capable as a normal chat turn.
  const assistantRef = useRef(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // The active listen-loop stopper, and a busy flag so a wake utterance that lands
  // while a turn is already running is ignored.
  const listenStopRef = useRef<null | (() => void)>(null)
  const busyRef = useRef(false)
  const handsFreeRef = useRef(false)
  // Call mode (the CallScreen) drops the per-turn wake word: once the call is
  // connected, natural speech from the enrolled user fires each turn.
  const callMode = !!opts.callMode
  // Barge-in: while speaking in a call, run a concurrent echo-cancelled wakeguard
  // mic so "Harman stop / end the call / <new question>" interrupts playback. Kept
  // in a ref so the latest onEndCall is always reachable from the async speak.
  const onEndCallRef = useRef(opts.onEndCall)
  onEndCallRef.current = opts.onEndCall
  // Set when a barge-in requests a NEW turn mid-speech; picked up after playback
  // stops so we don't re-enter runTurn from inside itself.
  const bargeAskRef = useRef<string | null>(null)
  const sid = (path?.split("/").pop() || "").replace(/\.jsonl$/, "")

  useEffect(() => {
    prepareAudio().then((ok) => !ok && setPhase("denied"))
    isEnrolled().then(setEnrolled)
    // A call always uses the harness path (assistant appliance off). Only the Voice
    // screen honors the persisted "Assistant voice" toggle.
    if (!callMode) {
      isAssistantVoice().then((on) => {
        setAssistantVoiceState(on)
        assistantRef.current = on
      })
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      stopListening()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Wait for the in-flight turn to finish, then return the whole last exchange
   *  (final text + tool steps + plan) by reading + parsing the transcript tail —
   *  the same source and shape the chat thread renders, so the voice screen can
   *  show tools/plan/markdown identically. An agentic turn (tools, file reads) can
   *  run for minutes, so the cap is generous (2400 ticks × 1.5s = 60 min, matching
   *  the server's CHAT_TIMEOUT) — otherwise a long turn would resolve early. */
  const awaitReply = useCallback((): Promise<ExchangeItem | null> => {
    return new Promise((resolve) => {
      let ticks = 0
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        ticks++
        try {
          const s = await api.chatStatus(sid)
          if (!s.running || ticks > 2400) {
            if (pollRef.current) clearInterval(pollRef.current)
            pollRef.current = null
            const lines = await api.sessionRead(host, path || "", 60)
            const items = groupThread(parseTranscript(lines))
            let last: ExchangeItem | null = null
            for (const it of items) if (it.kind === "exchange" && it.finalText) last = it
            resolve(last)
          }
        } catch {
          /* keep polling through transient errors */
        }
      }, 1500)
    })
  }, [sid, host, path])

  /**
   * Speak `text`, and — only in a call with the native AEC module present — run a
   * concurrent echo-cancelled "wakeguard" mic so the user can barge in over the
   * assistant with "Harman …". On a hit:
   *   - stop      → halt playback, settle to waiting (no new turn).
   *   - end       → halt playback and end the CallKit call (via onEndCall).
   *   - ask(tail) → halt playback and stash the new question for runTurn to pick up.
   * Falls back to a plain `speak()` on the Voice screen or a build without the
   * native module (duplexAvailable() === false), so nothing regresses there.
   */
  const speakWithBargeIn = useCallback(
    async (text: string): Promise<void> => {
      if (!callMode || !duplexAvailable()) {
        await speak(text)
        return
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
            if (cmd.kind === "none") return // stray tail — keep speaking
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
            // Duck Harman's TTS the instant the user starts talking — well before
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
        await speak(text)
      } finally {
        await teardown()
      }
    },
    [callMode]
  )

  const runTurn = useCallback(
    async (text: string): Promise<void> => {
      if (!text.trim()) return
      setHeard(text)
      setPhase("thinking")
      try {
        if (assistantRef.current) {
          // Assistant appliance (Voice-screen toggle): the :8099 service answers AND
          // speaks in one fast stream — no chat pipeline, no transcript poll.
          setReply("")
          setReplyItem(null)
          setPhase("speaking")
          await speak(text, true)
          return
        }
        // Harness turn (default, and always in a call): run the full Claude harness
        // with the session's configured provider/model/mode (read server-side from
        // SESSION_META), await the whole turn, then speak the final text via Pocket.
        const p = composerPrefs()
        await api.chat({ message: text, path: path || undefined, host, agent: "claude", mode: p.mode, model: p.model })
        const item = await awaitReply()
        const answer = (item?.finalText || "").trim()
        setReply(answer)
        setReplyItem(item) // whole exchange (tools/plan/markdown) for chat-style render
        if (!answer) {
          // Turn produced no speakable text (e.g. tool-only turn or a hit cap) —
          // don't play silence; settle back to listening.
          setPhase(callMode ? "waiting" : "idle")
          return
        }
        setPhase("speaking")
        await speakWithBargeIn(answer)
        // Barge-in during playback may have asked a NEW question — run it now,
        // after this speak fully unwound (so we never re-enter from inside speak).
        const next = bargeAskRef.current
        bargeAskRef.current = null
        if (next) await runTurn(next)
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [host, path, awaitReply, callMode, speakWithBargeIn]
  )

  /** Each window's verdict from the server. Fire a turn only on a verified
   *  "Harman …" utterance; ignore idle windows and anything while already busy. */
  const onListenEvent = useCallback(
    async (e: ListenEvent) => {
      if (e.type === "unenrolled") {
        setEnrolled(false)
        setError("Enroll your voice first so Harman only answers you.")
        return
      }
      if (e.type === "error") return
      if (e.type !== "utterance" || !e.text.trim()) return
      if (busyRef.current) return // a turn is already running
      busyRef.current = true
      // Pause listening while we run + speak the turn (mic and playback share the
      // one audio session); resume afterward if still in hands-free mode.
      await stopListening()
      try {
        await runTurn(e.text)
      } finally {
        busyRef.current = false
        if (handsFreeRef.current) {
          setPhase("waiting")
          const stop = await startListening(onListenEvent, { speakerId: "default", callMode })
          listenStopRef.current = stop
        } else {
          setPhase("idle")
        }
      }
    },
    [runTurn]
  )

  /** Begin the hands-free listen loop: stream windows, act on wake utterances. */
  const startHandsFree = useCallback(async () => {
    setError("")
    handsFreeRef.current = true
    setPhase("waiting")
    const stop = await startListening(onListenEvent, { speakerId: "default", callMode })
    listenStopRef.current = stop
  }, [onListenEvent])

  /** Stop the hands-free loop and settle back to idle. */
  const stopHandsFree = useCallback(async () => {
    handsFreeRef.current = false
    listenStopRef.current = null
    await stopListening()
    if (!busyRef.current) setPhase("idle")
  }, [])

  /** Record ~5s and enroll the voiceprint so hands-free can verify the speaker. */
  const onEnroll = useCallback(async () => {
    setError("")
    setEnrolling(true)
    try {
      const ok = await enrollVoice(5, "default")
      setEnrolled(ok)
      if (!ok) setError("Enrollment failed — try again in a quiet spot.")
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setEnrolling(false)
    }
  }, [])

  /** Update the persisted assistant-voice preference + the live ref. */
  const setAssistantVoicePref = useCallback((on: boolean) => {
    setAssistantVoiceState(on)
    assistantRef.current = on
    // Persistence is handled by the caller (screen) via setAssistantVoice(); the
    // ref keeps runTurn in sync immediately.
  }, [])

  return {
    phase, setPhase, heard, setHeard, reply, replyItem, error, setError,
    runTurn, startHandsFree, stopHandsFree,
    enrolled, enrolling, onEnroll,
    assistantVoice, setAssistantVoicePref,
  }
}
