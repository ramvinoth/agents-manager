/**
 * Pan/zoom math for the full-screen diagram viewer. Pure, so it is unit-tested
 * without a browser; MermaidDiagram only wires pointer/wheel events to it.
 *
 * A view is a translate (x, y) then a uniform scale, applied to content whose
 * natural size is known: screen = content * scale + (x, y).
 */
export type View = { x: number; y: number; scale: number }
export type Size = { w: number; h: number }

export const MIN_SCALE = 0.1
export const MAX_SCALE = 8

export function clampScale(s: number): number {
  if (!Number.isFinite(s) || s <= 0) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
}

/** Scale by `factor` keeping the content point under screen point (px, py) fixed. */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const scale = clampScale(v.scale * factor)
  const k = scale / v.scale
  return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
}

/** Centre the content in the container, shrunk to fit (never enlarged past 1:1 beyond `maxFit`). */
export function fitView(content: Size, box: Size, pad = 16, maxFit = 2): View {
  if (content.w <= 0 || content.h <= 0 || box.w <= 0 || box.h <= 0) return { x: 0, y: 0, scale: 1 }
  const scale = clampScale(Math.min((box.w - 2 * pad) / content.w, (box.h - 2 * pad) / content.h, maxFit))
  return centered(content, box, scale)
}

/** Centre the content at a given scale (used for 100%). */
export function centered(content: Size, box: Size, scale: number): View {
  const s = clampScale(scale)
  return { scale: s, x: (box.w - content.w * s) / 2, y: (box.h - content.h * s) / 2 }
}

/** Wheel delta → zoom factor; trackpad pinch arrives as small ctrl+wheel deltas. */
export function wheelFactor(deltaY: number, ctrlKey: boolean): number {
  const step = ctrlKey ? 0.01 : 0.0015
  return Math.exp(-deltaY * step)
}
