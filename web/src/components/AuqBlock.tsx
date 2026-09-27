import { useEffect, useRef, useState } from "react"
import { HelpCircle, Check, ChevronDown, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { useStore, useAgentLabel } from "@/store"
import type { ToolUseBlock } from "@/lib/types"

interface Option {
  label: string
  description?: string
}
interface Question {
  question: string
  header?: string
  options?: Array<string | Option>
  multiSelect?: boolean
}

export function AuqBlock({ block }: { block: ToolUseBlock }) {
  const answerQuestion = useStore((s) => s.answerQuestion)
  const agentLabel = useAgentLabel()
  const input = block.input as { questions?: Question[] } | undefined
  const questions = input?.questions || []
  const answered = block.result != null
  const [picks, setPicks] = useState<Record<number, string[]>>({})
  const [note, setNote] = useState("")
  const [sent, setSent] = useState(false)
  // Once answered, fold to the header — a stack of answered questions otherwise
  // pushes the live conversation off screen. The card stays mounted across the
  // answer (the poll fills in `result`), so this reacts to the transition; an
  // explicit open/close by the reader wins.
  const [open, setOpen] = useState(!answered)
  const touched = useRef(false)
  useEffect(() => {
    if (!touched.current) setOpen(!answered)
  }, [answered])
  const toggle = () => {
    touched.current = true
    setOpen((o) => !o)
  }

  const optionsOf = (q: Question): Option[] =>
    (q.options || []).map((o) => (typeof o === "string" ? { label: o } : o))
  // A typed reply is the follow-up path: when no offered option fits, or a
  // pick needs a condition, the owner's words ARE the answer. It goes through
  // the same answer endpoint (same race-safe consume), so it can never queue
  // behind the run that is blocked on this very question.
  const hasNote = note.trim().length > 0
  const needsSubmit = !answered && (questions.length > 1 || questions.some((q) => q.multiSelect) || hasNote)

  function send(p: Record<number, string[]>) {
    if (sent) return
    // Every question must have a pick before we answer — unless the owner wrote
    // a reply, which stands on its own.
    if (!hasNote && questions.some((_, qi) => !(p[qi] || []).length)) return
    setSent(true)
    // One comma-joined label string per question, positionally aligned — the
    // server composes the answer text from these. This goes to the dedicated
    // question-answer endpoint (unblocks the waiting run / resumes it), NOT the
    // chat queue.
    const out = questions.map((_, qi) => (p[qi] || []).join(", "))
    answerQuestion(out, note.trim())
  }

  function pick(qi: number, label: string, multi: boolean) {
    if (answered || sent) return
    const cur = picks[qi] || []
    const next = multi ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label]
    const updated = { ...picks, [qi]: next }
    setPicks(updated)
    // A lone single-select question: the click IS the answer — unless a reply
    // is being written, in which case the pick waits for the Send button so the
    // note travels with it.
    if (questions.length === 1 && !questions[0].multiSelect && !hasNote) send(updated)
  }

  const answeredText = answered
    ? (typeof block.result === "string" ? block.result : JSON.stringify(block.result))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300)
    : ""

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
      <button
        type="button"
        onClick={toggle}
        className="mb-2 flex w-full items-center gap-1.5 text-xs font-medium text-primary"
      >
        <HelpCircle className="size-3.5" />
        <span>
          {agentLabel} asks
          {questions[0]?.header ? ` · ${questions[0].header}` : ""}
          {answered ? " · answered" : ""}
        </span>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      </button>
      {open &&
        questions.map((q, qi) => (
          <div key={qi} className="mb-3 last:mb-0">
            <div className="mb-1.5 font-medium">
              {q.question}
              {q.multiSelect && (
                <span className="ml-1 text-xs font-normal text-muted-foreground">(multiple allowed)</span>
              )}
            </div>
            <div className="grid gap-1.5">
              {optionsOf(q).map((o, oi) => {
                const picked = (picks[qi] || []).includes(o.label)
                return (
                  <button
                    key={oi}
                    disabled={answered || sent}
                    onClick={() => pick(qi, o.label, !!q.multiSelect)}
                    className={cn(
                      "flex flex-col rounded-md border px-3 py-2 text-left transition-colors",
                      picked ? "border-primary bg-primary/10" : "border-border hover:bg-accent",
                      (answered || sent) && "opacity-60"
                    )}
                  >
                    <span className="flex items-center gap-1.5 font-medium">
                      {picked && <Check className="size-3.5 text-primary" />}
                      {o.label}
                    </span>
                    {o.description && (
                      <span className="mt-0.5 text-xs text-muted-foreground">{o.description}</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      {open && !answered && (
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={sent}
          rows={2}
          placeholder="Or write your own reply — none of these fit, a condition, a question back…"
          className="mb-2 text-sm"
        />
      )}
      {open && needsSubmit && (
        <Button size="sm" disabled={sent} onClick={() => send(picks)}>
          {hasNote && !Object.values(picks).some((p) => p.length) ? "Send reply" : `Send answer${questions.length > 1 ? "s" : ""}`}
        </Button>
      )}
      {answered && <div className="mt-1 text-xs text-muted-foreground">Answered: {answeredText}</div>}
    </div>
  )
}
