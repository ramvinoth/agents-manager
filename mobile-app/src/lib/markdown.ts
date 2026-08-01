/**
 * Minimal markdown → block/span model for the chat thread.
 *
 * Deliberately dependency-free: adding a markdown package would be a native
 * dependency change (a ~10 min rebuild), whereas this ships over Metro in
 * seconds and is unit-testable in Node with no simulator. It covers what agent
 * replies actually contain — headings, bold/italic, inline code, fenced code,
 * lists, tables, blockquotes, links — and degrades to plain text for anything else.
 */

export type Span =
  | { t: "text"; s: string }
  | { t: "bold"; s: string }
  | { t: "italic"; s: string }
  | { t: "code"; s: string }
  | { t: "link"; s: string; href: string }

export type MdBlock =
  | { t: "p"; spans: Span[] }
  | { t: "h"; level: number; spans: Span[] }
  | { t: "code"; lang: string; text: string }
  | { t: "li"; ordered: boolean; marker: string; spans: Span[]; depth: number }
  | { t: "table"; header: string[]; rows: string[][] }
  | { t: "quote"; spans: Span[] }
  | { t: "hr" }

/** Inline spans. Code is extracted first so **bold** inside `code` stays literal. */
export function parseInline(src: string): Span[] {
  const out: Span[] = []
  // `code` | **bold** | __bold__ | *italic* | _italic_ | [text](href) | bare url
  const re =
    /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|(?<!\w)\*([^*\n]+?)\*(?!\w)|(?<!\w)_([^_\n]+?)_(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>)]+)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ t: "text", s: src.slice(last, m.index) })
    if (m[2] !== undefined) out.push({ t: "code", s: m[2] })
    else if (m[3] !== undefined) out.push({ t: "bold", s: m[3] })
    else if (m[4] !== undefined) out.push({ t: "bold", s: m[4] })
    else if (m[5] !== undefined) out.push({ t: "italic", s: m[5] })
    else if (m[6] !== undefined) out.push({ t: "italic", s: m[6] })
    else if (m[7] !== undefined) out.push({ t: "link", s: m[7], href: m[8] })
    else if (m[9] !== undefined) out.push({ t: "link", s: m[9], href: m[9] })
    last = re.lastIndex
  }
  if (last < src.length) out.push({ t: "text", s: src.slice(last) })
  return out.length ? out : [{ t: "text", s: src }]
}

const splitRow = (line: string): string[] =>
  line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim())

const isDivider = (line: string) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-")

export function parseMarkdown(src: string): MdBlock[] {
  const lines = (src || "").replace(/\r\n?/g, "\n").split("\n")
  const blocks: MdBlock[] = []
  let para: string[] = []

  const flushPara = () => {
    if (!para.length) return
    blocks.push({ t: "p", spans: parseInline(para.join("\n").trim()) })
    para = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Fenced code — consumed verbatim, no inline parsing inside.
    const fence = line.match(/^\s*```+\s*(\S+)?\s*$/)
    if (fence) {
      flushPara()
      const lang = fence[1] || ""
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) body.push(lines[i++])
      blocks.push({ t: "code", lang, text: body.join("\n") })
      continue
    }

    if (!line.trim()) {
      flushPara()
      continue
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara()
      blocks.push({ t: "hr" })
      continue
    }

    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
    if (h) {
      flushPara()
      blocks.push({ t: "h", level: h[1].length, spans: parseInline(h[2].trim()) })
      continue
    }

    // Table: a header row followed by a |---|---| divider.
    if (line.includes("|") && i + 1 < lines.length && isDivider(lines[i + 1])) {
      flushPara()
      const header = splitRow(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]))
      i--
      blocks.push({ t: "table", header, rows })
      continue
    }

    const q = line.match(/^\s{0,3}>\s?(.*)$/)
    if (q) {
      flushPara()
      blocks.push({ t: "quote", spans: parseInline(q[1]) })
      continue
    }

    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
    if (li) {
      flushPara()
      const ordered = /\d/.test(li[2])
      blocks.push({
        t: "li",
        ordered,
        marker: ordered ? li[2].replace(/[.)]$/, ".") : "•",
        spans: parseInline(li[3]),
        depth: Math.floor(li[1].replace(/\t/g, "  ").length / 2),
      })
      continue
    }

    para.push(line)
  }
  flushPara()
  return blocks
}
