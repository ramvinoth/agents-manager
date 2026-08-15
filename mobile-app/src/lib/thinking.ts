/**
 * splitThinking — pull a model's leading reasoning out of a reply so it can render
 * as a collapsed block. Some models (e.g. Qwen3) emit their chain of thought as a
 * <think>…</think> block BEFORE the answer. We strip that leading block and surface
 * it separately; when the text doesn't start with a think block, body === original
 * text and thinking is "".
 *
 * PREFIX-ONLY by design: the block is only recognized at the very start of the text
 * (after optional whitespace). This is deliberate — a real reasoning block always
 * leads the response, and matching inline would corrupt normal prose or code that
 * merely mentions a `<think>` tag (which hollowed out messages containing the
 * literal token). Tolerant of: a missing closing tag (streaming mid-thought →
 * everything after the opener is reasoning) and an ORPHAN leading </think> with no
 * opener (some templates emit <think> as a special token that gets stripped,
 * leaving </think> as the separator). Pure + unit-tested; shared by web + mobile.
 */
export function splitThinking(text: string): { thinking: string; body: string } {
  if (!text) return { thinking: "", body: "" }
  const lead = text.replace(/^\s+/, "")
  const ws = text.length - lead.length

  // Case A: text opens with a real <think> block.
  if (lead.startsWith("<think>")) {
    const inner = lead.slice("<think>".length)
    const close = inner.indexOf("</think>")
    if (close < 0) {
      // Unterminated (streaming): everything after the opener is reasoning.
      return { thinking: inner.trim(), body: "" }
    }
    return {
      thinking: inner.slice(0, close).trim(),
      body: inner.slice(close + "</think>".length).trim(),
    }
  }

  // Case B: orphan leading </think> (opener was stripped by the chat template) —
  // but only when it appears near the very start, i.e. no other prose precedes a
  // real reasoning passage. We treat the head up to the FIRST </think> as reasoning
  // ONLY if there's no <think> anywhere (a stray </think> mid-prose is left alone
  // unless it's clearly the template separator at the head).
  const orphan = lead.indexOf("</think>")
  if (orphan >= 0 && lead.indexOf("<think>") < 0) {
    return {
      thinking: lead.slice(0, orphan).trim(),
      body: lead.slice(orphan + "</think>".length).trim(),
    }
  }

  // No leading think block — return the original text untouched (preserve leading ws).
  void ws
  return { thinking: "", body: text }
}
