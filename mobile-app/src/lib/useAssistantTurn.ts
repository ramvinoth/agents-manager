/**
 * useAssistantTurn — the voice-turn engine behind the CallKit Call screen.
 *
 * It owns the phase state machine, the last-heard / last-reply / error strings,
 * and the hands-free loop (`startHandsFree`/`stopHandsFree`). Which engine runs
 * a call is the SERVER's decision, read once per call from
 * GET /api/voice/nemotron/status:
 *
 *   - "nemotron": the service is configured. Each recorded utterance is sent as
 *     one binary turn over /api/voice/nemotron/ws; the reply comes back as a WAV
 *     plus the assistant's transcript. No STT (the fork never returns what the
 *     caller said), no tools, no duplex — exactly what the service reports.
 *   - "brain": not configured. Utterances stream to /api/voice/ws for STT, the
 *     text goes to the call brain (`POST /api/call/turn`), and the reply is
 *     spoken through the TTS stream. The brain's memory (`history`) lives here
 *     for the length of the call and is echoed back on every turn.
 *
 * A configured-but-unreachable Nemotron service is an error the caller sees —
 * never a silent drop to the brain path.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { api, type CallHistory } from "../api/client"
import {
  playFile,
  prepareAudio,
  recordUtterance,
  speak,
  startListening,
  stopListening,
  stopSpeaking,
  type ListenEvent,
} from "./voice"
import { NemotronCall } from "./nemotron"
import { deleteNemotronReply, nemotronNativeBindings } from "./nemotronNative"
import { startWakeguard, duplexAvailable, type DuplexMic } from "./duplexMic"
import { parseBargeTail } from "./bargeCommand"
import { audioSession } from "./audioSessionNative"

// While the user speaks over Harman (before a command is confirmed), duck the TTS
// to this fraction of full volume so they can hear themselves. Restored to 1.0 on
// silence; a confirmed command halts playback entirely.
const DUCK_VOLUME = 0.25

// The voice loop's phases — each maps to a status line. "waiting" is the resting
// state of a connected call (listening for the next utterance); "connecting" is
// the Nemotron model loading for this call (tens of seconds, server-bounded).
export type Phase = "idle" | "connecting" | "waiting" | "thinking" | "speaking" | "denied"

/** Which server path a call is running on. Decided by the server, never here. */
export type Engine = "brain" | "nemotron"

export interface UseAssistantTurn {
  phase: Phase
  /** The engine of the current call, once the server has told us. */
  engine: Engine | null
  /** The server's own name for the model behind the call. */
  model: string
  /** What the caller last said (transcribed). Always "" on Nemotron — the
   *  service never returns the caller's words. */
  heard: string
  /** What Harman last said back. */
  reply: string
  error: string
  /** Run one brain turn from already-transcribed text: ask the call brain, speak its reply. */
  runTurn: (text: string) => Promise<void>
  /** Begin listening. On a connected Nemotron call this only resumes the record
   *  loop (mute → unmute); the socket and the loaded model stay up. */
  startHandsFree: () => Promise<void>
  /** Pause listening. The Nemotron socket stays connected; it closes on unmount. */
  stopHandsFree: () => Promise<void>
}

export function useAssistantTurn(
  path: string | undefined,
  opts: { onEndCall?: () => void } = {}
): UseAssistantTurn {
  const [phase, setPhase] = useState<Phase>("idle")
  const [engine, setEngine] = useState<Engine | null>(null)
  const [model, setModel] = useState("")
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
  // "Harman stop / end the call / <new question>" interrupt playback. Kept in a
  // ref so the latest onEndCall is always reachable from the async speak.
  const onEndCallRef = useRef(opts.onEndCall)
  onEndCallRef.current = opts.onEndCall
  // Set when a barge-in requests a NEW turn mid-speech; picked up after playback
  // stops so we don't re-enter runTurn from inside itself.
  const bargeAskRef = useRef<string | null>(null)
  // The one Nemotron call for this screen (null on the brain engine or before
  // connect). Closed on unmount — never on mute, since the model loads per call.
  const nemotronRef = useRef<NemotronCall | null>(null)
  const unmountedRef = useRef(false)

  useEffect(() => {
    prepareAudio().then((ok) => !ok && setPhase("denied"))
    return () => {
      unmountedRef.current = true
      stopListening()
      nemotronRef.current?.close()
      nemotronRef.current = null
    }
  }, [])

  /**
   * Run `play` (a TTS stream or a reply file), and — on a build with the native
   * AEC module — run a concurrent echo-cancelled "wakeguard" mic so the user can
   * barge in with "Harman …":
   *   - stop      → halt playback, settle to waiting (no new turn).
   *   - end       → halt playback and end the CallKit call (via onEndCall).
   *   - ask(tail) → halt playback and stash the new question for runTurn to pick up.
   * Falls back to plain playback without the native module.
   */
  const playWithBargeIn = useCallback(async (play: () => Promise<void>): Promise<void> => {
    if (!duplexAvailable()) {
      await play()
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
      await play()
    } finally {
      await teardown()
    }
  }, [])

  const runTurn = useCallback(
    async (text: string): Promise<void> => {
      if (!text.trim() || !path) return
      setHeard(text)
      setError("")
      setPhase("thinking")
      try {
        const res = await api.callTurn({ path, text, history: historyRef.current })
        historyRef.current = res.history
        setReply(res.reply)
        if (!res.reply.trim()) {
          setPhase("waiting")
          return
        }
        setPhase("speaking")
        await playWithBargeIn(() => speak(res.reply))
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

  /** One Nemotron turn: play the reply WAV, then delete the temp file. A barge-in
   *  "ask" has nowhere to go on this engine (no text turns), so it is dropped. */
  const playNemotronReply = useCallback(
    async (audioUri: string) => {
      try {
        await playWithBargeIn(() => playFile(audioUri))
      } finally {
        bargeAskRef.current = null
        deleteNemotronReply(audioUri)
      }
    },
    [playWithBargeIn]
  )

  /** The Nemotron record→turn→play loop. Runs while hands-free is on and the
   *  call is up; a silent window is dropped on-device without a round trip. */
  const runNemotronLoop = useCallback(
    async (call: NemotronCall) => {
      while (handsFreeRef.current && call.isReady && !unmountedRef.current) {
        setPhase("waiting")
        let utt: Awaited<ReturnType<typeof recordUtterance>> = { buf: null, silent: false }
        try {
          utt = await recordUtterance()
        } catch {
          utt = { buf: null, silent: false }
        }
        if (!handsFreeRef.current || !call.isReady) break
        if (utt.silent || !utt.buf || utt.buf.byteLength === 0) continue
        busyRef.current = true
        setPhase("thinking")
        try {
          const res = await call.sendTurn(utt.buf)
          setReply(res.text)
          setPhase("speaking")
          await playNemotronReply(res.audioUri)
        } catch (e) {
          setError((e as Error).message)
          if (!call.isReady) break // timeout/disconnect closed the call — onDown owns the phase
        } finally {
          busyRef.current = false
        }
      }
      if (handsFreeRef.current && !call.isReady) return // onDown reported it
      setPhase(handsFreeRef.current ? "waiting" : "idle")
    },
    [playNemotronReply]
  )

  /** Open the Nemotron call for this screen: connect, wait for the model's
   *  `ready`, then hand off to the loop. A disconnect at any point surfaces as
   *  an error and leaves "listening" — never hangs. */
  const startNemotron = useCallback(async () => {
    const existing = nemotronRef.current
    if (existing?.isReady) {
      runNemotronLoop(existing)
      return
    }
    existing?.close()
    const call = new NemotronCall(nemotronNativeBindings())
    nemotronRef.current = call
    call.onDown = (err) => {
      if (nemotronRef.current === call) nemotronRef.current = null
      if (unmountedRef.current) return
      if (handsFreeRef.current) setError(err.message)
      handsFreeRef.current = false
      setPhase("idle")
    }
    setPhase("connecting")
    const { url, headers } = api.nemotronWsUrl(path!)
    try {
      await call.connect(url, headers)
    } catch {
      return // onDown already reported the reason
    }
    if (!handsFreeRef.current || unmountedRef.current) return
    runNemotronLoop(call)
  }, [path, runNemotronLoop])

  /** Begin listening. The first start asks the server which engine this call
   *  runs on; later starts (unmute) reuse that decision. */
  const startHandsFree = useCallback(async () => {
    if (!path) return
    setError("")
    handsFreeRef.current = true
    let current = engine
    if (!current) {
      setPhase("connecting")
      try {
        const chosen = await api.callEngine()
        if (chosen.error) throw new Error(chosen.error)
        current = chosen.engine
        let name = chosen.model || ""
        if (current === "nemotron") {
          const st = await api.nemotronStatus()
          if (st.error) throw new Error(st.error)
          if (!st.installed) throw new Error("Nemotron voicechat is not installed on the GPU box")
          name = st.model || ""
        }
        setModel(name)
      } catch (e) {
        setError((e as Error).message)
        handsFreeRef.current = false
        setPhase("idle")
        return
      }
      if (!handsFreeRef.current) return
      setEngine(current)
    }
    if (current === "nemotron") {
      await startNemotron()
      return
    }
    setPhase("waiting")
    listenStopRef.current = await startListening(onListenEvent)
  }, [path, engine, onListenEvent, startNemotron])

  /** Pause listening and settle back to idle. The Nemotron socket is kept. */
  const stopHandsFree = useCallback(async () => {
    handsFreeRef.current = false
    listenStopRef.current = null
    await stopListening() // also releases the recorder mid-utterance on Nemotron
    if (!busyRef.current) setPhase("idle")
  }, [])

  return { phase, engine, model, heard, reply, error, runTurn, startHandsFree, stopHandsFree }
}
