/** Split leading model reasoning, leaving inline tag mentions in prose/code alone. */
export function splitThinking(text: string): { thinking: string; body: string } {
  if (!text) return { thinking: "", body: "" }
  const lead = text.replace(/^\s+/, "")
  if (lead.startsWith("<think>")) {
    const inner = lead.slice("<think>".length)
    const close = inner.indexOf("</think>")
    if (close < 0) return { thinking: inner.trim(), body: "" }
    return { thinking: inner.slice(0, close).trim(), body: inner.slice(close + "</think>".length).trim() }
  }
  // Some templates strip the opener. Avoid interpreting quoted/code examples
  // as that template separator; plain orphan tags remain inherently ambiguous.
  const orphan = lead.indexOf("</think>")
  if (orphan >= 0 && !lead.includes("<think>") && !/[`"']/.test(lead.slice(0, orphan))) {
    return { thinking: lead.slice(0, orphan).trim(), body: lead.slice(orphan + "</think>".length).trim() }
  }
  return { thinking: "", body: text }
}
