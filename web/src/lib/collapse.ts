/**
 * Deciding when a message is too long to show in full, and what its preview is.
 *
 * Pure so the thresholds and the fence repair are unit-tested without a browser;
 * the component only wires up the toggle.
 *
 * The preview is a slice of the ORIGINAL markdown source, not of rendered
 * output — that way the preview goes through the same renderer as the full text
 * and can't drift from it. The one hazard that creates is cutting inside a ```
 * fence: renderMarkdownSegments (lib/markdown.ts) matches fences with a regex
 * that REQUIRES a closing ```, so an unterminated one never matches and the code
 * falls through to renderInline, which escapes it and shows a literal ``` to the
 * reader. Closing the fence keeps the preview rendering as code.
 *
 * DUPLICATED from mobile-app/src/lib/collapse.ts, deliberately: the two apps
 * have no shared build. Keep them in sync BY HAND — and note the sibling
 * thinking.ts claims to mirror mobile's and no longer does, which is exactly the
 * drift this warning exists to prevent. Both copies are unit-tested; if you
 * change a threshold here, change it there and run both suites.
 */

export type Collapse = {
  /** True when `preview` hides something and a "Show more" is warranted. */
  collapsed: boolean
  /** What to render while collapsed. Equals the input when `collapsed` is false. */
  preview: string
  /** How many source lines the preview leaves out — shown on the toggle. */
  hiddenLines: number
}

const MAX_LINES = 14
const MAX_CHARS = 900
/** Collapsing that saves a line or two costs the reader a click and saves nothing. */
const MIN_HIDDEN_LINES = 3

/** Close an unterminated ``` fence so a mid-fence cut still parses. */
function repairFence(src: string): string {
  const open = src.split("\n").filter((l) => /^\s*```/.test(l)).length
  return open % 2 === 0 ? src : src + "\n```"
}

export function collapsePreview(
  text: string,
  maxLines: number = MAX_LINES,
  maxChars: number = MAX_CHARS,
): Collapse {
  const full = text ?? ""
  const lines = full.split("\n")
  const overLines = lines.length > maxLines
  const overChars = full.length > maxChars
  if (!overLines && !overChars) return { collapsed: false, preview: full, hiddenLines: 0 }

  let cut = lines.slice(0, maxLines).join("\n")
  if (cut.length > maxChars) {
    cut = cut.slice(0, maxChars)
    // Prefer a word boundary so the preview doesn't end mid-token, but only if
    // one is near the end — a long unbroken run (a URL, a base64 blob) has none
    // and must not collapse the preview to almost nothing.
    const sp = cut.lastIndexOf(" ")
    if (sp > maxChars * 0.8) cut = cut.slice(0, sp)
  }
  // A cut that hides nothing is not a collapse.
  if (cut.length >= full.length) return { collapsed: false, preview: full, hiddenLines: 0 }

  const hiddenLines = lines.length - cut.split("\n").length
  if (!overChars && hiddenLines < MIN_HIDDEN_LINES) {
    return { collapsed: false, preview: full, hiddenLines: 0 }
  }
  return { collapsed: true, preview: repairFence(cut.replace(/\s+$/, "")), hiddenLines }
}
