import { useMemo } from "react"
import { renderMarkdownSegments } from "@/lib/markdown"
import { MermaidDiagram } from "./MermaidDiagram"

export function Markdown({ text }: { text: string }) {
  // Split into segments so ```mermaid fences render as React-owned <MermaidDiagram>
  // components (SVG in state) instead of imperatively-injected SVG inside
  // dangerouslySetInnerHTML — the latter was wiped by every streaming re-render /
  // poll / scroll, causing the diagram to flicker and reset to code.
  const dark = document.documentElement.classList.contains("dark")
  const segments = useMemo(() => renderMarkdownSegments(text), [text])
  return (
    <div className="markdown-content">
      {segments.map((seg, i) =>
        seg.type === "mermaid" ? (
          <MermaidDiagram key={i} source={seg.source} dark={dark} />
        ) : (
          // .md-segment is `display: contents` — the wrapper exists only because
          // dangerouslySetInnerHTML needs an element, and it must not become a
          // layout box, or the spacing rules would apply to IT rather than to
          // the paragraphs and headings inside it. That was why a message split
          // across segments spaced differently from one that was not.
          <div key={i} className="md-segment" dangerouslySetInnerHTML={{ __html: seg.html }} />
        )
      )}
    </div>
  )
}
