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
          <div key={i} dangerouslySetInnerHTML={{ __html: seg.html }} />
        )
      )}
    </div>
  )
}
