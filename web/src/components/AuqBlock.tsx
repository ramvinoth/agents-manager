import { useState } from "react"
import { HelpCircle, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
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
  const [sent, setSent] = useState(false)

  const optionsOf = (q: Question): Option[] =>
    (q.options || []).map((o) => (typeof o === "string" ? { label: o } : o))
  const needsSubmit = !answered && (questions.length > 1 || questions.some((q) => q.multiSelect))

  function send(p: Record<number, string[]>) {
    if (sent) return
    // Every question must have a pick before we answer.
    if (questions.some((_, qi) => !(p[qi] || []).length)) return
    setSent(true)
    // One comma-joined label string per question, positionally aligned — the
    // server composes the answer text from these. This goes to the dedicated
    // question-answer endpoint (unblocks the waiting run / resumes it), NOT the
    // chat queue.
    const out = questions.map((_, qi) => (p[qi] || []).join(", "))
    answerQuestion(out)
  }

  function pick(qi: number, label: string, multi: boolean) {
    if (answered || sent) return
    const cur = picks[qi] || []
    const next = multi ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label]
    const updated = { ...picks, [qi]: next }
    setPicks(updated)
    // A lone single-select question: the click IS the answer.
    if (questions.length === 1 && !questions[0].multiSelect) send(updated)
  }

  const answeredText = answered
    ? (typeof block.result === "string" ? block.result : JSON.stringify(block.result))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300)
    : ""

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-primary">
        <HelpCircle className="size-3.5" /> {agentLabel} asks
        {questions[0]?.header ? ` · ${questions[0].header}` : ""}
      </div>
      {questions.map((q, qi) => (
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
      {needsSubmit && (
        <Button size="sm" disabled={sent} onClick={() => send(picks)}>
          Send answer{questions.length > 1 ? "s" : ""}
        </Button>
      )}
      {answered && <div className="mt-1 text-xs text-muted-foreground">Answered: {answeredText}</div>}
    </div>
  )
}
