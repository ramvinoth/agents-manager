/**
 * AskUserQuestion support — the agent asks a question with options and the user
 * answers by tapping. Port of the web AuqBlock's semantics:
 *   - one single-select question: tapping an option IS the answer
 *   - multi-select or multiple questions: picks accumulate, then submit
 * The answer is sent as a plain chat message (that is how the web replies too).
 */

export type AuqOption = { label: string; description?: string }
export type AuqQuestion = { question: string; header?: string; options: AuqOption[]; multiSelect: boolean }

/** Normalize the tool_use input into questions. The `input` may arrive as a
 *  parsed object OR as a JSON string (the streaming transport sometimes delivers
 *  tool args un-parsed) — handle both, plus a top-level array of questions. A
 *  string that isn't JSON simply yields no questions (caller renders nothing). */
export function parseQuestions(input: unknown): AuqQuestion[] {
  let obj: any = input
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj)
    } catch {
      return []
    }
  }
  // Accept {questions:[…]}, a bare […] of questions, or a single question object.
  const qs = Array.isArray(obj) ? obj : Array.isArray(obj?.questions) ? obj.questions : obj?.question ? [obj] : null
  if (!Array.isArray(qs)) return []
  return qs
    .filter((q: any) => q && typeof q.question === "string")
    .map((q: any) => ({
      question: q.question,
      header: typeof q.header === "string" ? q.header : undefined,
      multiSelect: !!q.multiSelect,
      options: (Array.isArray(q.options) ? q.options : []).map((o: any) =>
        typeof o === "string" ? { label: o } : { label: String(o?.label ?? ""), description: o?.description }
      ).filter((o: AuqOption) => o.label),
    }))
}

/** Toggle/select an option. Returns the updated picks map. */
export function pickOption(
  picks: Record<number, string[]>,
  qi: number,
  label: string,
  multi: boolean
): Record<number, string[]> {
  const cur = picks[qi] || []
  const next = multi ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label]
  return { ...picks, [qi]: next }
}

/** True when every question has at least one pick. */
export function allAnswered(questions: AuqQuestion[], picks: Record<number, string[]>): boolean {
  return questions.length > 0 && questions.every((_, qi) => (picks[qi] || []).length > 0)
}

/**
 * The chat message that answers the question(s). Each answer embeds the question
 * text so it's self-contained: a resumed run a day later (claude --resume) sees
 * "You asked: … → pick" and needs no guessing about which prompt it answers.
 */
export function composeAnswer(questions: AuqQuestion[], picks: Record<number, string[]>): string {
  const parts: string[] = []
  questions.forEach((q, qi) => {
    const picked = picks[qi] || []
    if (picked.length) parts.push(`You asked: "${q.question}" → ${picked.join(", ")}`)
  })
  return parts.join("\n")
}

/** Tap-to-answer shortcut applies only to a lone single-select question. */
export function isInstant(questions: AuqQuestion[]): boolean {
  return questions.length === 1 && !questions[0].multiSelect
}
