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
  | { t: "math"; s: string }   // inline TeX (between $…$ / \(…\)) — rendered natively-ish
  | { t: "wikilink"; s: string; target: string }   // [[Target#Heading|shown]] — notes only
  | { t: "tag"; s: string; tag: string }           // #tag (s as written, tag lower-cased) — notes only

export type MdBlock =
  | { t: "p"; spans: Span[] }
  | { t: "h"; level: number; spans: Span[] }
  | { t: "code"; lang: string; text: string }
  | { t: "li"; ordered: boolean; marker: string; spans: Span[]; depth: number }
  | { t: "table"; header: string[]; rows: string[][] }
  | { t: "quote"; spans: Span[] }
  | { t: "hr" }
  | { t: "mathblock"; text: string }   // display TeX (between $$…$$ / \[…\]) — WebView

// $…$ | \(…\) math | `code` | **bold** | __bold__ | *italic* | _italic_ | [text](href) | url
const INLINE =
  /\$([^\n$]+?)\$|\\\(([^]+?)\\\)|(`+)([^`]+?)\3|\*\*([^*]+?)\*\*|__([^_]+?)__|(?<!\w)\*([^*\n]+?)\*(?!\w)|(?<!\w)_([^_\n]+?)_(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>)]+)/
// Notes add Obsidian syntax (same grammar as viewer/notelinks.py): [[Target#Heading|alias]]
// and #tag (after a space/"(", not a digit first, so "#42" and "C#" stay text).
const NOTE_SYNTAX =
  /\[\[([^[\]|#\n]*)(#[^[\]|\n]*)?(\|[^[\]\n]*)?\]\]|(?<![^\s(])#(?![0-9])([^\s!"#$%&'()*+,.:;<=>?@[\]^`{|}~\\]+)/
const CHAT_RE = new RegExp(INLINE.source, "g")
const NOTE_RE = new RegExp(INLINE.source + "|" + NOTE_SYNTAX.source, "g")

/** Inline spans. Math is matched FIRST so `_`/`*` inside a formula (A_k, \phi_k)
 *  can't be mis-read as italic; code next so **bold** inside `code` stays literal.
 *  `notes` turns on [[links]] and #tags — never in chat, where "#" is just text. */
export function parseInline(src: string, notes = false): Span[] {
  const out: Span[] = []
  const re = notes ? NOTE_RE : CHAT_RE
  re.lastIndex = 0
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    // $…$ math, but not currency: skip if it starts/ends with a space or is a bare number.
    if (m[1] !== undefined) {
      const t = m[1]
      if (/^\s|\s$/.test(t) || /^\d[\d.,]*$/.test(t)) continue  // "$5 and $6", "$9.99" → literal
    }
    if (m.index > last) out.push({ t: "text", s: src.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ t: "math", s: m[1].trim() })
    else if (m[2] !== undefined) out.push({ t: "math", s: m[2].trim() })
    else if (m[4] !== undefined) out.push({ t: "code", s: m[4] })
    else if (m[5] !== undefined) out.push({ t: "bold", s: m[5] })
    else if (m[6] !== undefined) out.push({ t: "bold", s: m[6] })
    else if (m[7] !== undefined) out.push({ t: "italic", s: m[7] })
    else if (m[8] !== undefined) out.push({ t: "italic", s: m[8] })
    else if (m[9] !== undefined) out.push({ t: "link", s: m[9], href: m[10] })
    else if (m[11] !== undefined) out.push({ t: "link", s: m[11], href: m[11] })
    else if (m[12] !== undefined) {
      const target = m[12].trim(), head = (m[13] || "").slice(1).trim(), alias = (m[14] || "").slice(1).trim()
      if (!target) out.push({ t: "text", s: m[0] })   // [[#Heading]]: a link inside the note itself
      else out.push({ t: "wikilink", target, s: alias || (head ? `${target} › ${head}` : target) })
    } else if (m[15] !== undefined) {
      const tag = m[15].replace(/[/-]+$/, "")
      if (!tag) out.push({ t: "text", s: m[0] })
      else {
        out.push({ t: "tag", s: "#" + tag, tag: tag.toLowerCase() })
        if (tag.length < m[15].length) out.push({ t: "text", s: m[15].slice(tag.length) })
      }
    }
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

/**
 * Vertical space (pt) above block `next` when it follows `prev`. One rule for
 * every place markdown renders, so sections and paragraphs breathe evenly:
 * consecutive list items stay tight, a heading opens a new section with room
 * above and hugs its own content, everything else is separated like
 * paragraphs. The first block gets nothing — the container owns its padding.
 */
export function blockGap(prev: MdBlock | undefined, next: MdBlock): number {
  if (!prev) return 0
  // A heading under a heading stays with it; otherwise sections open wide, wider for h1/h2.
  if (next.t === "h") return prev.t === "h" ? 8 : next.level <= 2 ? 24 : 18
  if (prev.t === "h") return 6
  if (prev.t === "li" && next.t === "li") return 4
  return 12
}

export function parseMarkdown(src: string, notes = false): MdBlock[] {
  const inline = (s: string) => parseInline(s, notes)
  const lines = (src || "").replace(/\r\n?/g, "\n").split("\n")
  const blocks: MdBlock[] = []
  let para: string[] = []

  const flushPara = () => {
    if (!para.length) return
    blocks.push({ t: "p", spans: inline(para.join("\n").trim()) })
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

    // Display math — $$…$$ or \[…\], possibly spanning multiple lines. Rendered
    // as a centered equation (WebView) rather than inline.
    const dm = line.match(/^\s*(\$\$|\\\[)(.*)$/)
    if (dm) {
      const open = dm[1]
      const close = open === "$$" ? "$$" : "\\]"
      let rest = dm[2]
      const buf: string[] = []
      // Single-line case: $$ x $$ on one line.
      const endIdx = rest.indexOf(close)
      if (endIdx >= 0) {
        buf.push(rest.slice(0, endIdx))
      } else {
        buf.push(rest)
        i++
        while (i < lines.length && lines[i].indexOf(close) < 0) buf.push(lines[i++])
        if (i < lines.length) buf.push(lines[i].slice(0, lines[i].indexOf(close)))
      }
      const tex = buf.join("\n").trim()
      if (tex) {
        flushPara()
        blocks.push({ t: "mathblock", text: tex })
        continue
      }
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
      blocks.push({ t: "h", level: h[1].length, spans: inline(h[2].trim()) })
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
      blocks.push({ t: "quote", spans: inline(q[1]) })
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
        spans: inline(li[3]),
        depth: Math.floor(li[1].replace(/\t/g, "  ").length / 2),
      })
      continue
    }

    para.push(line)
  }
  flushPara()
  return blocks
}
