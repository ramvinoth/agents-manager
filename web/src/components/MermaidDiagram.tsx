import { useEffect, useRef, useState } from "react"
import {
  renderMermaidToSvg,
  copyToClipboard,
  downloadMermaidPng,
  downloadMermaidSvg,
} from "@/lib/mermaid"
import { DiagramViewer } from "@/components/DiagramViewer"

/**
 * MermaidDiagram — renders a ```mermaid fence as a React-owned diagram.
 *
 * The SVG lives in component state, so React owns the DOM: streaming re-renders,
 * polls, and scroll re-mounts never wipe it (unlike the old approach that
 * imperatively injected SVG into dangerouslySetInnerHTML and had to fight React
 * to keep it there). The diagram is rendered once per (source, theme) and cached
 * in lib/mermaid, so re-mounts reuse the string with no flicker.
 */
export function MermaidDiagram({ source, dark }: { source: string; dark: boolean }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [showCode, setShowCode] = useState(false)
  const [copied, setCopied] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const svgHostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    setFailed(false)
    renderMermaidToSvg(source, dark).then(
      (out) => { if (alive) setSvg(out) },
      () => { if (alive) { setFailed(true); setShowCode(true) } }
    )
    return () => { alive = false }
  }, [source, dark])

  const onCopy = async () => {
    await copyToClipboard(source)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  // Exports always render a fresh DARK-themed diagram from source (with a dark
  // background), independent of the in-app theme.
  const doPng = () => { downloadMermaidPng(source); setMenuOpen(false) }
  const doSvg = () => { downloadMermaidSvg(source); setMenuOpen(false) }

  // Show the diagram when we have SVG and aren't in code view; otherwise source.
  const showDiagram = !!svg && !showCode && !failed

  return (
    <div className="mermaid-diagram">
      <div className="mermaid-toolbar">
        {!failed && (
          <button type="button" onClick={() => setShowCode((v) => !v)} title="Toggle diagram / source">
            {showCode ? "Diagram" : "Code"}
          </button>
        )}
        <button type="button" className={copied ? "copied" : undefined} onClick={onCopy} title="Copy diagram source">
          {copied ? "Copied" : "Copy"}
        </button>
        {showDiagram && (
          <button type="button" onClick={() => setExpanded(true)} title="Full screen — zoom and pan">
            Expand
          </button>
        )}
        {showDiagram && (
          <div className="mermaid-dl-wrap">
            <button type="button" onClick={() => setMenuOpen((v) => !v)} title="Download diagram">
              Download
            </button>
            {menuOpen && (
              <div className="mermaid-dl-menu" onMouseLeave={() => setMenuOpen(false)}>
                <button type="button" onClick={doPng}>PNG (image)</button>
                <button type="button" onClick={doSvg}>SVG (vector)</button>
              </div>
            )}
          </div>
        )}
      </div>

      {showDiagram ? (
        <div
          ref={svgHostRef}
          className="mermaid-svg"
          role="button"
          tabIndex={0}
          title="Open full screen to zoom"
          onClick={() => setExpanded(true)}
          onKeyDown={(e) => { if (e.key === "Enter") setExpanded(true) }}
          // The SVG string comes from mermaid with securityLevel:"strict" (no
          // scripts/handlers), and is React-owned — set once from state, never
          // fought over by a re-render.
          dangerouslySetInnerHTML={{ __html: svg! }}
        />
      ) : (
        <pre className="mermaid-src"><code className="language-mermaid">{source}</code></pre>
      )}
      {svg && <DiagramViewer svg={svg} open={expanded} onOpenChange={setExpanded} />}
    </div>
  )
}
