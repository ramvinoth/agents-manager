import { useEffect, useMemo, useState, type MouseEvent } from "react"
import { katexLoaded, loadKatex, renderMarkdownSegments, type NoteSyntax } from "@/lib/markdown"
import { MermaidDiagram } from "./MermaidDiagram"

// Cheap pre-check for math delimiters; extractMath decides what really is math.
const MAYBE_MATH = /\$|\\\(|\\\[/

/** `notes` turns on note syntax ([[links]] and #tags) and receives their
 *  clicks — one delegated handler, since the HTML is injected. */
export type NoteLinkHandlers = NoteSyntax & { onLink: (target: string) => void; onTag?: (tag: string) => void }

export function Markdown({ text, notes }: { text: string; notes?: NoteLinkHandlers }) {
  // Split into segments so ```mermaid fences render as React-owned <MermaidDiagram>
  // components (SVG in state) instead of imperatively-injected SVG inside
  // dangerouslySetInnerHTML — the latter was wiped by every streaming re-render /
  // poll / scroll, causing the diagram to flicker and reset to code.
  const dark = document.documentElement.classList.contains("dark")
  const [mathReady, setMathReady] = useState(katexLoaded)
  const wantsMath = !mathReady && MAYBE_MATH.test(text)
  useEffect(() => {
    if (!wantsMath) return
    let alive = true
    loadKatex().then(() => alive && setMathReady(true), () => {})
    return () => { alive = false }
  }, [wantsMath])
  const segments = useMemo(() => renderMarkdownSegments(text, notes), [text, notes, mathReady]) // mathReady: re-render once KaTeX lands
  function onClick(e: MouseEvent<HTMLDivElement>) {
    if (!notes) return
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-note],[data-tag]")
    if (!el) return
    e.preventDefault()
    if (el.dataset.note !== undefined) notes.onLink(el.dataset.note)
    else if (el.dataset.tag) notes.onTag?.(el.dataset.tag)
  }
  return (
    <div className="markdown-content" onClick={onClick}>
      {segments.map((seg, i) =>
        seg.type === "mermaid" ? (
          <MermaidDiagram key={i} source={seg.source} dark={dark} />
        ) : (
          <div key={i} dangerouslySetInnerHTML={{ __html: seg.html }} />
        )
      )}
    </div>
  )
}
