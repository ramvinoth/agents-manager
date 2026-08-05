/**
 * mermaid.ts — lazy, theme-aware Mermaid rendering helpers for the transcript.
 *
 * Mermaid is heavy, so it's dynamically imported the first time a diagram appears.
 * `renderMermaidToSvg` returns an SVG string (cached by source+theme) that the
 * <MermaidDiagram> React component holds in state — React owns the DOM, so
 * re-renders/polls never wipe it (no observers, no innerHTML races). The
 * download helpers are used by that component's toolbar.
 */
let _mermaidPromise: Promise<typeof import("mermaid").default> | null = null
let _seq = 0
/** Cache of rendered SVG keyed by `${theme}:${source}`, so a given diagram is only
 *  rendered once and re-mounts/re-renders reuse the string instantly. */
const _svgCache = new Map<string, string>()

async function getMermaid(dark: boolean) {
  if (!_mermaidPromise) {
    _mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({
        startOnLoad: false,
        securityLevel: "strict", // no click-handlers / scripts from model output
        theme: dark ? "dark" : "default",
        fontFamily: "inherit",
        // Native <text> labels instead of <foreignObject> HTML — the latter taints
        // a <canvas>, which made PNG export throw and silently fall back to SVG.
        flowchart: { htmlLabels: false },
        htmlLabels: false,
      })
      return m.default
    })
  }
  return _mermaidPromise
}

/** Render mermaid `source` to an SVG string. Cached by source+theme. Throws on an
 *  invalid diagram (caller falls back to showing the source). */
export async function renderMermaidToSvg(source: string, dark: boolean): Promise<string> {
  const key = `${dark ? "d" : "l"}:${source}`
  const cached = _svgCache.get(key)
  if (cached) return cached
  const mermaid = await getMermaid(dark)
  const id = `mmd-${Date.now().toString(36)}-${_seq++}`
  const { svg } = await mermaid.render(id, source)
  _svgCache.set(key, svg)
  return svg
}

/** Copy text to the clipboard, with a fallback for insecure/older contexts. */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand("copy") } catch { /* ignore */ }
    document.body.removeChild(ta)
  }
}

const DARK_BG = "#0d1117" // GitHub-dark canvas; matches mermaid "dark" theme

/** Render `source` to a dark-themed SVG string with a solid dark background rect
 *  inserted, so exports (PNG/SVG) always read well standalone regardless of the
 *  in-app theme. Cached like the display render. */
async function renderDarkExportSvg(source: string): Promise<string> {
  const svg = await renderMermaidToSvg(source, true) // force dark theme
  // Insert a full-bleed background rect right after the opening <svg …> tag.
  return svg.replace(
    /(<svg\b[^>]*>)/,
    `$1<rect x="0" y="0" width="100%" height="100%" fill="${DARK_BG}"/>`
  )
}

/** Download the diagram as a dark-themed, lossless vector SVG. */
export async function downloadMermaidSvg(source: string): Promise<void> {
  const xml = await renderDarkExportSvg(source)
  saveBlob(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }), "diagram.svg")
}

/** Download the diagram as a high-resolution dark PNG. Renders a fresh dark SVG,
 *  sizes off its intrinsic viewBox, over-samples 3×, and rasterises on a dark
 *  canvas. Falls back to the SVG only if canvas encoding genuinely fails. */
export async function downloadMermaidPng(source: string): Promise<void> {
  const xml = await renderDarkExportSvg(source)
  // Parse to read intrinsic dimensions from the viewBox.
  const doc = new DOMParser().parseFromString(xml, "image/svg+xml")
  const svgEl = doc.documentElement as unknown as SVGSVGElement
  const vb = svgEl.getAttribute("viewBox")?.split(/[\s,]+/).map(Number)
  const w = Math.max(1, Math.ceil((vb && vb[2]) || Number(svgEl.getAttribute("width")) || 800))
  const h = Math.max(1, Math.ceil((vb && vb[3]) || Number(svgEl.getAttribute("height")) || 600))
  svgEl.setAttribute("width", String(w))
  svgEl.setAttribute("height", String(h))
  svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet")
  const sized = new XMLSerializer().serializeToString(svgEl)
  const svgBlob = new Blob([sized], { type: "image/svg+xml;charset=utf-8" })
  const url = URL.createObjectURL(svgBlob)
  const img = new Image()
  const scale = 3
  await new Promise<void>((resolve) => {
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas")
        canvas.width = w * scale
        canvas.height = h * scale
        const ctx = canvas.getContext("2d")
        if (!ctx) throw new Error("no ctx")
        ctx.fillStyle = DARK_BG
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url)
          if (blob) saveBlob(blob, "diagram.png")
          else saveBlob(svgBlob, "diagram.svg")
          resolve()
        }, "image/png")
      } catch {
        URL.revokeObjectURL(url)
        saveBlob(svgBlob, "diagram.svg")
        resolve()
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      saveBlob(svgBlob, "diagram.svg")
      resolve()
    }
    img.src = url
  })
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
