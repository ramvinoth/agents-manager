/**
 * splitThinking — pull a model's leading reasoning out of a reply so it can render
 * as a collapsed block. Some models (e.g. Qwen3) emit their chain of thought as a
 * <think>…</think> block BEFORE the answer. We strip that leading block and surface
 * it separately; when the text doesn't start with a think block, body === original
 * text and thinking is "".
 *
 * PREFIX-ONLY by design: the block is only recognized at the very start of the text
 * (after optional whitespace). A real reasoning block always leads the response, and
 * matching inline would corrupt normal prose or code that merely mentions a
 * `<think>` tag. Mirrors mobile-app/src/lib/thinking.ts.
 */
export function splitThinking(text: string): { thinking: string; body: string } {
  if (!text) return { thinking: "", body: "" }
  const lead = text.replace(/^\s+/, "")

  if (lead.startsWith("<think>")) {
    const inner = lead.slice("<think>".length)
    const close = inner.indexOf("</think>")
    if (close < 0) return { thinking: inner.trim(), body: "" }
    return {
      thinking: inner.slice(0, close).trim(),
      body: inner.slice(close + "</think>".length).trim(),
    }
  }

  const orphan = lead.indexOf("</think>")
  if (orphan >= 0 && lead.indexOf("<think>") < 0) {
    return {
      thinking: lead.slice(0, orphan).trim(),
      body: lead.slice(orphan + "</think>".length).trim(),
    }
  }

  return { thinking: "", body: text }
}
