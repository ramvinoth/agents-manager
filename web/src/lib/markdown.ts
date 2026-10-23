// Markdown → HTML — ported from the vanilla MarkdownRenderer. Returns an HTML
// string rendered via dangerouslySetInnerHTML inside a .markdown-content box.

import type katexModule from "katex"

// KaTeX (~270 KB + CSS) loads the first time a message holds math, not with the
// app. Until it arrives a formula renders as its source in <code>; <Markdown>
// re-renders once loadKatex() resolves.
let katex: typeof katexModule | null = null
let katexLoading: Promise<void> | null = null
export const katexLoaded = () => katex !== null
export function loadKatex(): Promise<void> {
  katexLoading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([m]) => { katex = m.default })
  return katexLoading
}

/** Render one TeX string to KaTeX HTML. throwOnError:false → a malformed formula
 *  shows KaTeX's red error text instead of throwing / blanking the message. */
function renderKatex(tex: string, display: boolean): string {
  if (!katex) throw new Error("katex not loaded")
  return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "html" })
}

/** Pull math out of a text run, calling `stash(tex, display)` for each and
 *  replacing it with whatever placeholder stash returns. Delimiters, in priority:
 *  $$…$$ and \[…\] (display), then $…$ and \(…\) (inline). A single `$` only opens
 *  math when a closing `$` exists on the same line AND the content isn't a bare
 *  number (so prices like "$5" / "$5 and $6" stay literal). Escaped \$ is literal. */
export function extractMath(text: string, stash: (tex: string, display: boolean) => string): string {
  // Guard escaped dollar signs so they survive as literals.
  let s = text.replace(/\\\$/g, "\u0000DOLLAR\u0000")
  // Display: $$...$$ and \[...\]
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => stash(tex.trim(), true))
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex) => stash(tex.trim(), true))
  // Inline: \(...\)
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex) => stash(tex.trim(), false))
  // Inline: $...$  — same line, non-empty, not a currency amount.
  s = s.replace(/\$([^\n$]+?)\$/g, (m, tex) => {
    const t = String(tex)
    if (/^\s|\s$/.test(t)) return m               // "$5 and $6" -> space-adjacent, not math
    if (/^\d[\d.,]*$/.test(t)) return m           // "$5" bare price, leave literal
    return stash(t.trim(), false)
  })
  return s.split("\u0000DOLLAR\u0000").join("$")   // restore escaped dollars as literal '$'
}

const KEYWORDS: Record<string, string> = {
  js: "const,let,var,function,return,if,else,for,while,class,import,export,from,async,await,new,this,try,catch,throw,switch,case,break,default,null,undefined,true,false",
  javascript:
    "const,let,var,function,return,if,else,for,while,class,import,export,from,async,await,new,this,try,catch,throw,switch,case,break,default,null,undefined,true,false",
  python:
    "def,class,return,if,elif,else,for,while,import,from,as,try,except,finally,with,yield,lambda,pass,break,continue,True,False,None,and,or,not,in,is,self,async,await,raise",
  py: "def,class,return,if,elif,else,for,while,import,from,as,try,except,finally,with,yield,lambda,pass,break,continue,True,False,None,and,or,not,in,is,self,async,await,raise",
  bash: "if,then,else,fi,for,do,done,while,case,esac,function,return,local,export,echo,cd,grep,find,cat,mkdir,rm,sudo,git,docker",
  sh: "if,then,else,fi,for,do,done,while,case,esac,function,return,local,export,echo,cd,grep,find,cat,mkdir,rm,sudo,git,docker",
  ts: "const,let,var,function,return,if,else,for,while,class,import,export,from,async,await,new,this,try,catch,throw,interface,type,enum,extends,implements,null,undefined,true,false",
  typescript:
    "const,let,var,function,return,if,else,for,while,class,import,export,from,async,await,new,this,try,catch,throw,interface,type,enum,extends,implements,null,undefined,true,false",
}

export function esc(t: string): string {
  return t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function highlightCode(code: string, lang: string): string {
  if (!lang || lang === "text" || lang === "plaintext") return code
  const kws = KEYWORDS[lang]?.split(",") || []
  if (!kws.length) return code
  const tokens: string[] = []
  let rem = code
  while (rem.length > 0) {
    let m: RegExpMatchArray | null
    if ((m = rem.match(/^(["'`])(?:(?!\1|\\).|\\.)*\1/))) {
      tokens.push(`<span class="sh-string">${m[0]}</span>`)
      rem = rem.slice(m[0].length)
      continue
    }
    if ((m = rem.match(/^(\/\/.*|#.*)/))) {
      tokens.push(`<span class="sh-comment">${m[0]}</span>`)
      rem = rem.slice(m[0].length)
      continue
    }
    if ((m = rem.match(/^\b\d+\.?\d*\b/))) {
      tokens.push(`<span class="sh-number">${m[0]}</span>`)
      rem = rem.slice(m[0].length)
      continue
    }
    if ((m = rem.match(/^\b[a-zA-Z_]\w*\b/))) {
      tokens.push(kws.includes(m[0]) ? `<span class="sh-keyword">${m[0]}</span>` : m[0])
      rem = rem.slice(m[0].length)
      continue
    }
    tokens.push(rem[0])
    rem = rem.slice(1)
  }
  return tokens.join("")
}

function buildTable(rows: string[][]): string {
  if (!rows.length) return ""
  let h = "<table><thead><tr>" + rows[0].map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>"
  for (let i = 1; i < rows.length; i++)
    h += "<tr>" + rows[i].map((c) => `<td>${c}</td>`).join("") + "</tr>"
  return h + "</tbody></table>"
}

function renderTables(h: string): string {
  const lines = h.split("\n")
  const result: string[] = []
  let inTable = false
  let rows: string[][] = []
  for (const line of lines) {
    if (line.match(/^\|(.+)\|$/)) {
      if (line.match(/^\|[\s\-:|]+\|$/)) continue
      if (!inTable) {
        inTable = true
        rows = []
      }
      rows.push(
        line
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim())
      )
    } else {
      if (inTable) {
        result.push(buildTable(rows))
        inTable = false
        rows = []
      }
      result.push(line)
    }
  }
  if (inTable) result.push(buildTable(rows))
  return result.join("\n")
}

/** Notes-only syntax: `[[Title#Heading|alias]]` links and `#tags`
 *  (viewer/notelinks.py is the grammar). Off for chat text, where `[[` and
 *  `#` mean nothing. `resolves` says whether a link target exists, so an
 *  unwritten one renders as a ghost the reader can click to create. */
export type NoteSyntax = { resolves: (target: string) => boolean }

function unesc(t: string): string {
  return t.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}

// Applied to escaped HTML. The first alternative lets <code> (and, for tags,
// an already-rendered link) through untouched, so code is never a link or a tag.
// A target may hold an apostrophe, which esc() has turned into "&#39;".
const WIKI_RE = /(<code>[\s\S]*?<\/code>)|\[\[((?:&#39;|[^[\]|#\n])*)(#[^[\]|\n]*)?(\|[^[\]\n]*)?\]\]/g
const TAG_RE = /(<code>[\s\S]*?<\/code>|<a [^>]*>[\s\S]*?<\/a>)|(^|[\s(])#(?![0-9])([^\s!"#$%&'()*+,.:;<=>?@[\]^`{|}~\\]+)/gm

function renderNoteSyntax(h: string, syntax: NoteSyntax): string {
  h = h.replace(WIKI_RE, (m, code, target, heading, alias) => {
    if (code) return code
    const t = String(target).trim()
    if (!t) return m
    const head = heading ? String(heading).slice(1).trim() : ""
    const shown = alias ? String(alias).slice(1).trim() || t : head ? `${t} › ${head}` : t
    const ghost = syntax.resolves(unesc(t)) ? "" : " ghost"
    return `<a class="wikilink${ghost}" data-note="${t}" href="#" title="${ghost ? "Not written yet — click to create" : t}">${shown}</a>`
  })
  return h.replace(TAG_RE, (m, code, pre, tag) => {
    if (code) return code
    const t = String(tag).replace(/[/-]+$/, "")
    return t ? `${pre}<span class="note-tag" data-tag="${t.toLowerCase()}">#${t}</span>` + String(tag).slice(t.length) : m
  })
}

function renderInline(text: string, syntax?: NoteSyntax): string {
  // Extract math FIRST (before esc + all inline rules) so `_`/`*`/`&` inside a
  // formula can't be mangled by italic/bold/escaping. Each match is replaced by an
  // opaque placeholder, KaTeX-rendered, and restored at the very end.
  const math: string[] = []
  const stash = (tex: string, display: boolean): string => {
    let html: string
    try {
      html = renderKatex(tex, display)
    } catch {
      html = `<code>${esc((display ? "$$" : "$") + tex + (display ? "$$" : "$"))}</code>`
    }
    math.push(html)
    return ` MATH${math.length - 1} `
  }
  let src = extractMath(text, stash)
  let h = esc(src)
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>")
  h = h.replace(/^#### (.+)$/gm, "<h4>$1</h4>")
  h = h.replace(/^### (.+)$/gm, "<h3>$1</h3>")
  h = h.replace(/^## (.+)$/gm, "<h2>$1</h2>")
  h = h.replace(/^# (.+)$/gm, "<h1>$1</h1>")
  h = h.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
  h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  h = h.replace(/\*(.+?)\*/g, "<em>$1</em>")
  h = h.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>")
  h = h.replace(/^---$/gm, "<hr>")
  if (syntax) h = renderNoteSyntax(h, syntax)
  // Links: allowlist safe schemes (esc has already neutralised quotes/angle
  // brackets, so no attribute breakout) — block javascript:/data:/etc. A link
  // with no scheme, or file://, is a file an agent wrote ("docs/report.md"):
  // it carries its raw href in data-file and the Markdown component opens it
  // (resolved against the session's folder only when tapped — lib/fileLink).
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) => {
    const url = String(href).trim()
    if (/^(https?:\/\/|mailto:)/i.test(url)) return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`
    if (url.startsWith("#")) return `<a href="${url}">${text}</a>`
    if (/^file:\/\//i.test(url) || !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url))
      return `<a href="#" class="file-link" data-file="${url}">${text}</a>`
    return `<a href="#">${text}</a>`
  })
  h = h.replace(/^(\s*)[-*] (.+)$/gm, "$1<li>$2</li>")
  h = h.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>")
  h = h.replace(/^\d+\. (.+)$/gm, "<li>$1</li>")
  h = renderTables(h)
  h = h.replace(/^(?!<[hupblotra]|<li|<hr|<blockquote|<pre|<code|\s*$)(.+)$/gm, "<p>$1</p>")
  h = h.replace(/<p>\s*<\/p>/g, "")
  // Restore KaTeX HTML in place of the placeholders (the space padding we added
  // survives esc/inline; match it loosely).
  h = h.replace(/\s?MATH(\d+)\s?/g, (_m, n) => math[Number(n)] ?? _m)
  return h
}

/** A rendered markdown segment: either an HTML blob (injected via
 *  dangerouslySetInnerHTML) or a mermaid diagram (rendered by a React component
 *  that OWNS its SVG, so React re-renders never wipe it). */
export type MarkdownSegment =
  | { type: "html"; html: string }
  | { type: "mermaid"; source: string }

/** Split markdown into React-renderable segments, isolating ```mermaid fences so
 *  each becomes a stateful <MermaidDiagram> instead of imperatively-injected SVG
 *  living inside React-owned innerHTML (the source of the wipe/flicker bugs). */
export function renderMarkdownSegments(text: string, syntax?: NoteSyntax): MarkdownSegment[] {
  if (!text || typeof text !== "string") return []
  const segs: MarkdownSegment[] = []
  let htmlBuf = ""
  const flush = () => {
    if (htmlBuf) {
      segs.push({ type: "html", html: htmlBuf })
      htmlBuf = ""
    }
  }
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g
  let lastIdx = 0
  let match: RegExpExecArray | null
  const emitPart = (part: { type: "text" | "code"; content: string; lang?: string }) => {
    if (part.type === "code") {
      if ((part.lang || "").toLowerCase() === "mermaid") {
        flush()
        segs.push({ type: "mermaid", source: part.content })
        return
      }
      htmlBuf += `<pre><code class="language-${part.lang}">${highlightCode(
        esc(part.content),
        part.lang || ""
      )}</code></pre>`
      return
    }
    htmlBuf += renderInline(part.content, syntax)
  }
  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIdx)
      emitPart({ type: "text", content: text.slice(lastIdx, match.index) })
    emitPart({ type: "code", lang: match[1], content: match[2].trim() })
    lastIdx = match.index + match[0].length
  }
  if (lastIdx < text.length) emitPart({ type: "text", content: text.slice(lastIdx) })
  flush()
  return segs
}
