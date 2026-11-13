import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, Mic, Square, ThumbsDown, ThumbsUp } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import {
  audioUrl,
  emptyTurn,
  fmtMs,
  labNoteBody,
  labNoteTitle,
  labStep,
  medianTtfa,
  type LabAnswer,
  type LabEngine,
  type LabTurn,
  type LabVerdict,
} from "@/lib/callLab"

type Msg = { role: string; content: unknown }
type Reply = LabAnswer & { history?: Msg[]; tools?: string[] }

/**
 * CallLabDialog: try the phone call brain from the browser. Type a question,
 * hear the answer and read its time to first audio, stop it mid-answer
 * (barge-in), rate each turn and save the run as a note. It talks to the same
 * /api/call/* turn endpoints as the phone, which answer with the LFM3 brain
 * whatever engine the phone is set to. The live Fish engine needs a microphone
 * stream, so it can only be tried on the phone.
 */
export function CallLabDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const [engine, setEngine] = useState<LabEngine | null>(null)
  const [text, setText] = useState("")
  const [turns, setTurns] = useState<LabTurn[]>([])
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const audio = useRef<HTMLAudioElement | null>(null)
  const history = useRef<Msg[]>([])
  const nextId = useRef<string | null>(null)
  const cancelled = useRef(false)

  useEffect(() => {
    api.getJSON<LabEngine>("/api/call/engine").then(setEngine).catch(() => setEngine(null))
    return () => {
      cancelled.current = true
      audio.current?.pause()
    }
  }, [])

  const patch = useCallback((id: number, p: Partial<LabTurn>) => {
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)))
  }, [])

  /** Play one AAC segment; resolves with the ms to first audio and when it ended or was stopped. */
  const playSegment = useCallback((url: string, started: number) => new Promise<number | null>((resolve) => {
    const el = new Audio(url)
    audio.current = el
    let ttfa: number | null = null
    el.addEventListener("playing", () => { if (ttfa === null) ttfa = Math.round(performance.now() - started) }, { once: true })
    const done = () => resolve(ttfa)
    el.addEventListener("ended", done, { once: true })
    el.addEventListener("pause", done, { once: true })
    el.addEventListener("error", done, { once: true })
    el.play().catch(done)
  }), [])

  const ask = useCallback(async (spoken?: string) => {
    const q = (spoken ?? text).trim()
    if (!q || busy) return
    const id = turns.length + 1
    setTurns((ts) => [...ts, emptyTurn(id, q)])
    setText("")
    setBusy(true)
    cancelled.current = false
    const started = performance.now()
    const say: string[] = []
    const tools: string[] = []
    let ttfa: number | null = null
    try {
      let res = await api.postJSON<Reply>("/api/call/turn", { path, text: q, history: history.current })
      while (true) {
        if (res.history) history.current = res.history
        if (res.tools) tools.push(...res.tools)
        if (res.said) say.push(res.said)
        const step = labStep(res)
        if (step.kind === "text") { say.push(step.text); break }
        if (step.kind === "done") break
        nextId.current = step.next
        const first = await playSegment(audioUrl(path, step.audio), started)
        if (ttfa === null) ttfa = first
        patch(id, { ttfaMs: ttfa })
        const stop = cancelled.current
        res = await api.postJSON<Reply>("/api/call/next", { path, next: step.next, stop })
        nextId.current = null
        if (stop) {
          if (res.history) history.current = res.history
          if (res.said) say.push(res.said)
          patch(id, { interrupted: true })
          break
        }
      }
    } catch (e) {
      say.push(`error: ${e instanceof Error ? e.message : "request failed"}`)
    }
    patch(id, { ttfaMs: ttfa, totalMs: Math.round(performance.now() - started), said: say.join(" ").trim(), tools })
    setBusy(false)
  }, [text, busy, turns.length, path, patch, playSegment])

  const [listening, setListening] = useState(false)
  const recog = useRef<{ stop: () => void } | null>(null)
  const SR = typeof window === "undefined" ? undefined
    : (window as unknown as { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: new () => any }).webkitSpeechRecognition

  /** Push to talk: the browser transcribes one utterance, then it is sent like a typed turn. */
  const listen = () => {
    if (!SR || busy) return
    if (listening) { recog.current?.stop(); return }
    const r = new SR()
    r.lang = "en-US"
    r.interimResults = false
    r.onresult = (e: any) => { void ask(String(e.results[0][0].transcript)) }
    r.onend = () => setListening(false)
    r.onerror = () => setListening(false)
    recog.current = r
    setListening(true)
    r.start()
  }

  const stop = () => {
    cancelled.current = true
    audio.current?.pause()
  }

  const rate = (id: number, verdict: LabVerdict) =>
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, verdict: t.verdict === verdict ? null : verdict } : t)))

  const save = async () => {
    if (!engine || !turns.length) return
    setSaved("saving")
    try {
      await api.orgCreateNote({ title: labNoteTitle(engine, new Date()), body: labNoteBody(engine, turns), kind: "note" })
      setSaved("saved")
    } catch {
      setSaved("error")
    }
  }

  const median = medianTtfa(turns)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[85vh] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-5 pt-5 pb-3">
          <DialogTitle>Voice Lab</DialogTitle>
          <DialogDescription>
            {`Typed or spoken turns answered by the call brain${engine ? ` · phone engine: ${engine.engine}` : ""}${median !== null ? ` · median first audio ${fmtMs(median)}` : ""}`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {turns.length === 0 && <p className="text-sm text-muted-foreground">Type something to say. You will hear the reply and see how fast the first sound arrived.</p>}
          {turns.map((t) => (
            <div key={t.id} className="rounded-md border border-border p-3 text-sm">
              <div className="font-medium">{t.question}</div>
              <div className="mt-1 text-muted-foreground">{t.said || (t.totalMs === null ? "Thinking…" : "(nothing said)")}</div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>first audio {fmtMs(t.ttfaMs)}</span>
                <span>total {fmtMs(t.totalMs)}</span>
                {t.interrupted && <span>interrupted</span>}
                {t.tools.length > 0 && <span>tools: {t.tools.join(", ")}</span>}
                <span className="ml-auto flex gap-1">
                  {(["up", "down"] as const).map((v) => (
                    <button key={v} aria-label={v === "up" ? "Good" : "Bad"} onClick={() => rate(t.id, v)}
                      className={cn("rounded p-1 hover:bg-accent", t.verdict === v && "bg-accent text-foreground")}>
                      {v === "up" ? <ThumbsUp className="size-3.5" /> : <ThumbsDown className="size-3.5" />}
                    </button>
                  ))}
                </span>
              </div>
              <input value={t.note} onChange={(e) => patch(t.id, { note: e.target.value })} placeholder="What was off or good?"
                className="mt-2 w-full rounded border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-ring" />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask()}
            placeholder="Say something…"
            className="min-w-0 flex-1 rounded border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-ring" />
          {busy ? (
            <Button variant="outline" onClick={stop}><Square className="mr-1 size-3.5" />Stop</Button>
          ) : (
            <>
              {SR && (
                <Button variant={listening ? "default" : "outline"} onClick={listen} aria-label={listening ? "Stop listening" : "Talk"}>
                  <Mic className="size-4" />
                </Button>
              )}
              <Button onClick={() => ask()} disabled={!text.trim()}>Send</Button>
            </>
          )}
          <Button variant="outline" onClick={save} disabled={!turns.length || busy || saved === "saving"}>
            {saved === "saving" ? <Loader2 className="size-4 animate-spin" /> : saved === "saved" ? "Saved" : saved === "error" ? "Retry save" : "Save to notes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
