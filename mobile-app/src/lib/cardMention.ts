// "Card 460" / "card #460" in an agent reply or inbox message opens that card.
// Pure string work; the tap target lives in components/CardMentions.tsx.
// Mirrored in web/src/lib/markdown.ts (linkifyCardMentions).

export type CardPiece = { text: string; id?: number }

const MENTION = /\b([Cc]ards? )#?(\d+)\b/g

/** Split `text` into plain pieces and card mentions (those carry the card id). */
export function splitCardMentions(text: string): CardPiece[] {
  const out: CardPiece[] = []
  let last = 0
  for (const m of text.matchAll(MENTION)) {
    const at = m.index ?? 0
    if (at > last) out.push({ text: text.slice(last, at) })
    out.push({ text: m[0], id: Number(m[2]) })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}
